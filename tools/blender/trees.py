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


def grow(objs, p, direction, length, radius, depth, rng, leaf_r=1.15, cards=None, centre=None):
    """One branch, then the two or three that come off it. With `cards`, the
    twig tips carry clusters of leaf cards round `centre`, the crown's middle;
    without, the old squashed spheres (kept for nothing but the record)."""
    d = mathutils.Vector(direction).normalized()
    tip_r = radius * 0.68
    if cards is not None:
        objs.append(limb(p, d, length, radius, tip_r, sides=7 if depth >= 1 else 5))
    else:
        objs.append(segment(p, d, length, radius, tip_r,
                            verts=6 if depth < 2 else 5))
    tip = mathutils.Vector(p) + d * length
    if cards is not None and depth == 1:
        # Leaves on the fork as well as the twigs, or the crown is a ring of
        # clusters round an empty middle.
        leaf_cluster(cards, tip, d, leaf_r * 0.8, rng, centre, count=9)
    if depth <= 0:
        if cards is not None:
            leaf_cluster(cards, tip, d, leaf_r, rng, centre)
            return
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
             depth - 1, rng, leaf_r * 0.84, cards, centre)


def outward(p, centre, up=0.45):
    """A crown normal: away from the crown's middle, tipped towards the sky,
    so a mass of cards lights as one rounded volume."""
    o = mathutils.Vector(p) - mathutils.Vector(centre)
    if o.length < 1e-6:
        o = mathutils.Vector((0, 0, 1))
    return o.normalized() + mathutils.Vector((0, 0, up))


def leaf_cluster(cards, tip, d, radius, rng, centre, count=18):
    """A twig's worth of leafy sprays: cards fanning out of the tip in every
    direction but inwards, each a spray of leaves, so the cluster is a ragged
    ball with sky through its edges -- the thing a squashed sphere could
    never be."""
    out = (mathutils.Vector(tip) - mathutils.Vector(centre))
    out.z *= 0.6
    out = out.normalized() if out.length > 1e-6 else mathutils.Vector((0, 0, 1))
    for k in range(count):
        # Directions over the outer hemisphere of the tip, and a third of
        # them any way at all, so the cluster fills in behind its own face.
        a = rng.uniform(0, 2 * math.pi)
        e = rng.uniform(-0.6, 0.9)
        rnd = mathutils.Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))
        u = (rnd + (out * 0.9 + d * 0.3) * (0.2 if k % 3 == 0 else 1.0)).normalized()
        side = u.cross(mathutils.Vector((0, 0, 1)))
        if side.length < 1e-3:
            side = mathutils.Vector((1, 0, 0))
        roll = rng.uniform(-0.6, 0.6)
        v = (side.normalized() * math.cos(roll) + u.cross(side).normalized() * math.sin(roll))
        base = mathutils.Vector(tip) - u * radius * 0.45 + rnd * radius * 0.25
        length = radius * rng.uniform(1.15, 1.55)
        mid = base + u * length * 0.5
        cards.card(base, u, v, length, radius * rng.uniform(0.7, 0.9), 0.25, outward(mid, centre))


def build_tree_oak():
    """About 8 m: trunk to the first fork at 2.6, canopy from 4 to 8.

    The crown is leaf cards now -- sprays of lobed leaves, alpha-cut, hung in
    clusters off every twig tip with their normals pointing out of the crown
    -- where it was a heap of squashed spheres wearing the `leaves` mass
    texture, which read as camouflage netting. The trunk and limbs are
    unwrapped so the bark's fissures run along them."""
    lib.reset()
    rng = random.Random(70012)
    objs = []
    cards = Cards("oakleaf", tile=1.0)
    trunk_h, r = 3.0, 0.36
    sides = 12
    wob = [0.05 * math.sin(2 * math.pi * i / sides * 2 + 0.4) + rng.uniform(-0.025, 0.025) for i in range(sides)]
    objs.append(hull([(0.0, r * 1.4, 0, 0), (0.35, r * 1.2, 0, 0), (1.4, r * 1.05, 0, 0),
                      (trunk_h + 0.3, r * 0.84, 0, 0)], sides, wob, mat="bark", name="trunk", unwrap=True))
    # Root flare: four buttresses so the trunk grows out of the ground.
    for i in range(4):
        a = 2 * math.pi * (i + 0.25) / 4
        objs.append(segment((math.cos(a) * 0.3, math.sin(a) * 0.3, 0.0),
                            (math.cos(a) * 0.35, math.sin(a) * 0.35, 1.0), 0.8,
                            0.17, 0.05, verts=5, name="root"))
    centre = (0.0, 0.0, 5.9)
    for i in range(3):
        a = 2 * math.pi * (i + rng.uniform(-0.12, 0.12)) / 3
        d = (math.cos(a) * 0.46, math.sin(a) * 0.46, 1.0)
        grow(objs, (0, 0, trunk_h), d, 2.35, r * 0.82, 2, rng, leaf_r=1.75, cards=cards, centre=centre)
    return deliver_conifer(objs, cards.mesh("leaves"), "tree_oak")


def build_tree_pine():
    """A western hemlock, 12 m: see `conifer`. The name is the library's, from
    when this was a pine; parks and forests both place it."""
    return conifer("tree_pine", HEMLOCK)


def build_bush():
    """A garden shrub, 1.3 m: five stems and a dome of leafy sprays fanning
    out of them, alpha-cut, with normals out of the dome. It was eleven
    squashed spheres in the `leaves` texture -- camouflage, a judge said."""
    lib.reset()
    rng = random.Random(70014)
    objs = []
    cards = Cards("shrubleaf", tile=0.8)
    for i in range(5):
        a = 2 * math.pi * i / 5
        objs.append(segment((math.cos(a) * 0.06, math.sin(a) * 0.06, 0),
                            (math.cos(a) * 0.42, math.sin(a) * 0.42, 1.0),
                            0.72, 0.055, 0.02, verts=4, name="stem"))
    centre = mathutils.Vector((0.0, 0.0, 0.62))
    for k in range(34):
        # Spread evenly over the dome by a golden-angle spiral, then jittered.
        a = k * 2.39996 + rng.uniform(-0.3, 0.3)
        e = math.asin(min(0.98, 0.05 + 0.93 * (k + 0.5) / 34)) * rng.uniform(0.85, 1.05)
        u = mathutils.Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e) * 0.9))
        base = centre + u * rng.uniform(0.08, 0.22) - mathutils.Vector((0, 0, 0.12))
        side = u.cross(mathutils.Vector((0, 0, 1)))
        if side.length < 1e-3:
            side = mathutils.Vector((1, 0, 0))
        v = side.normalized()
        length = rng.uniform(0.62, 0.8)
        cards.card(base, u, v, length, rng.uniform(0.42, 0.55), 0.3, outward(base + u * length * 0.5, centre, 0.3))
    return deliver_conifer(objs, cards.mesh("leaves"), "bush")


def build_hedge(name, L, D, H, seed):
    """A clipped hedge, `L` long, `D` deep and `H` tall: the Shire's kept
    hedgerows and the knot of hedge at a lane corner.

    Its turf banks and corners were half-ellipsoids in the lawn texture, and a
    judge saw four-metre faceted green domes. A hedge is leaf over a woody
    frame: stems out of the ground branching into it, and small-leaved sprays
    laid over a rounded box -- the shape the shears keep -- tipped a little
    out of it so the outline is leafy and not ruled. Thinner at the foot,
    where the shade kills the leaves and the stems show."""
    lib.reset()
    rng = random.Random(seed)
    objs = []
    cards = Cards("hedgeleaf", tile=0.6)
    hx, hy, hz = L / 2, D / 2, H / 2
    ex = 5.0

    def surface(d):
        """Where direction `d` from the centre meets the rounded box, and the
        box's normal there."""
        k = (abs(d.x / hx) ** ex + abs(d.y / hy) ** ex + abs(d.z / hz) ** ex) ** (1.0 / ex)
        q = d / k
        n = mathutils.Vector((abs(q.x / hx) ** (ex - 1) * math.copysign(1, q.x) / hx,
                              abs(q.y / hy) ** (ex - 1) * math.copysign(1, q.y) / hy,
                              abs(q.z / hz) ** (ex - 1) * math.copysign(1, q.z) / hz)).normalized()
        return q, n

    # The frame: stems from the ground forking into the body.
    for i in range(max(4, int(L * 1.6))):
        x = -hx * 0.85 + (2 * hx * 0.85) * (i + rng.uniform(0.2, 0.8)) / max(4, int(L * 1.6))
        base = mathutils.Vector((x, rng.uniform(-hy, hy) * 0.3, 0.0))
        d = mathutils.Vector((rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 1.0))
        objs.append(segment(tuple(base), tuple(d), H * 0.55, 0.045, 0.025, verts=5, name="stem"))
        for side in (-1, 1):
            d2 = mathutils.Vector((rng.uniform(-0.4, 0.4), side * rng.uniform(0.4, 0.8), 0.9))
            objs.append(segment(tuple(base + d.normalized() * H * 0.3), tuple(d2), H * 0.4, 0.028, 0.012,
                                verts=4, name="branch"))
    centre = mathutils.Vector((0, 0, hz))
    area = 2 * (L * D + L * H + D * H)
    count = int(area * 10)
    placed = 0
    tries = 0
    while placed < count and tries < count * 4:
        tries += 1
        d = mathutils.Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1)))
        if d.length < 1e-6:
            continue
        q, n = surface(d)
        z = q.z + hz
        if z < 0.12 or (z < 0.45 and rng.random() < 0.6):
            continue
        # Narrower at the foot: the shade underneath has killed the outer leaf.
        foot = 1.0 - 0.14 * max(0.0, 1.0 - z / (H * 0.35))
        p = mathutils.Vector((q.x * foot, q.y * foot, z))
        t = n.cross(mathutils.Vector((0, 0, 1)))
        if t.length < 1e-3:
            t = mathutils.Vector((1, 0, 0))
        t.normalize()
        b = n.cross(t)
        a = rng.uniform(0, 2 * math.pi)
        u = (t * math.cos(a) + b * math.sin(a))
        # Tipped out of the surface a little: a clipped face, but a leafy one.
        u = (u + n * rng.uniform(0.03, 0.16)).normalized()
        v = n.cross(u).normalized()
        length = rng.uniform(0.36, 0.5)
        width = rng.uniform(0.28, 0.36)
        base = p - u * length * 0.45 - n * rng.uniform(0.02, 0.08)
        cards.card(base, u, v, length, width, 0.2, n + mathutils.Vector((0, 0, 0.35)))
        placed += 1
    # A second, inner layer, so the gaps in the first show leaf and not sky.
    for k in range(int(count * 0.25)):
        d = mathutils.Vector((rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1)))
        q, n = surface(d)
        p = centre + (q) * 0.7
        if p.z < 0.3:
            continue
        u = mathutils.Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.3, 0.6))).normalized()
        v = n.cross(u)
        if v.length < 1e-3:
            continue
        cards.card(p, u, v.normalized(), 0.55, 0.4, 0.2, n + mathutils.Vector((0, 0, 0.35)))
    return deliver_conifer(objs, cards.mesh("leaves"), name)


def build_hedge_clump():
    return build_hedge("hedge_clump", 3.4, 3.4, 2.2, 70031)


def build_hedge_row():
    return build_hedge("hedge_row", 6.6, 1.3, 1.9, 70033)


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


# Bark tiles in metres: the viewer's `scale` for each recipe in textures.js.
# An unwrapped trunk closes its seam on a whole number of them, so these have
# to match the recipes.
BARK_TILE = {"bark": 1.6, "mossbark": 1.6, "firbark": 1.4, "cedarbark": 1.2}


def mark_own_uv(obj):
    """Flag every face as carrying UVs of its own, which the delivery keeps
    instead of cube-projecting over them."""
    attr = obj.data.attributes.get("own_uv") or obj.data.attributes.new("own_uv", "INT", "FACE")
    for item in attr.data:
        item.value = 1
    return obj


def hull(rings, sides, wob=None, jag=None, jag_at=-1, mat="rock", name="hull", unwrap=False):
    """Rings of (z, radius, cx, cy) skinned into one closed solid.

    `wob` is a per-angle radius multiplier. Sharing one between two shells is
    what lets a moss cap lie parallel to the boulder underneath it rather than
    cutting through it at four places. `jag` is the same trick for height, on
    the ring at `jag_at`: a ragged hem for the moss, and for the snag a top
    that was snapped rather than sawn.

    Rings must run upwards. Listing them downwards turns every normal inward,
    and a rock lit from the inside looks exactly like a hole in the ground.

    `unwrap` gives the sides cylindrical UVs in metres -- round the hull in u,
    up it in v -- instead of leaving them to the delivery's cube projection.
    A bark's ridges have to run up a trunk; cube-projected, every facet took
    them at another slant and the rings met at seams, which read as chevrons.
    The circumference is rounded to whole tiles of the material so the seam
    closes, and it stays that many tiles as the trunk tapers, so the plates
    narrow towards the top the way real bark does."""
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
    if unwrap:
        tile = BARK_TILE[mat]
        around = max(1, round(2 * math.pi * rings[0][1] / tile)) * tile
        layer = mesh.uv_layers.new(name="UVMap")
        for poly in mesh.polygons:
            corners = []
            if poly.index < (n - 1) * sides:
                k, i = divmod(poly.index, sides)
                # The face runs i, i+1 round the ring; the last one closes on
                # u = around rather than wrapping back to 0.
                for (col, row) in ((i, k), (i + 1, k), (i + 1, k + 1), (i, k + 1)):
                    corners.append((around * col / sides, verts[row * sides + col % sides][2]))
            else:
                for li in poly.loop_indices:
                    x, y, _ = verts[mesh.loops[li].vertex_index]
                    corners.append((x, y))
            for li, uv in zip(poly.loop_indices, corners):
                layer.data[li].uv = uv
    mesh.validate()
    mesh.update()
    obj = lib.bpy.data.objects.new(name, mesh)
    lib.bpy.context.collection.objects.link(obj)
    if unwrap:
        mark_own_uv(obj)
    return lib.assign(obj, mat)


def limb(p0, direction, length, r0, r1, sides=7, mat="bark", name="limb"):
    """A branch as an unwrapped hull, so its bark runs along it: a cone with
    cube-projected UVs wears the plates at whatever slant it happens to lean."""
    obj = hull([(0.0, r0, 0, 0), (length, r1, 0, 0)], sides, mat=mat, name=name, unwrap=True)
    d = mathutils.Vector(direction).normalized()
    obj.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    obj.location = tuple(p0)
    lib.apply_modifiers(obj)
    return obj


# --- the conifers -----------------------------------------------------------

class Cards:
    """Foliage cards collected into one mesh: positions, per-corner UVs
    (the card is the whole texture tile, 0..1, repeated once per `tile`
    metres along it) and a per-vertex normal that points out of the crown
    rather than off the card. `mat` is the cut-out recipe they wear."""

    def __init__(self, mat="needles", tile=0.6):
        self.verts, self.faces, self.uvs, self.normals = [], [], [], []
        self.mat = mat
        self.tile = tile

    def card(self, base, u_dir, v_dir, length, width, fold, out):
        """A spray from `base` along `u_dir`, `width` across `v_dir`, folded
        along its midrib by `fold` (the edges lifted along `out`), so it has
        body when seen edge-on. Two quads, four triangles."""
        u = mathutils.Vector(u_dir).normalized()
        v = mathutils.Vector(v_dir).normalized()
        n = mathutils.Vector(out).normalized()
        b = mathutils.Vector(base)
        lift = n * (fold * width * 0.5)
        rows = []
        # One spray of the texture per `tile` of card, not one per card: a
        # single two-metre spray is a fern frond, not a fir bough.
        repeat = max(1.0, round(length / self.tile))
        for (s, vv) in ((0.0, 0.0), (0.0, 0.5), (0.0, 1.0), (1.0, 0.0), (1.0, 0.5), (1.0, 1.0)):
            edge = abs(vv - 0.5) * 2
            p = b + u * (length * s) + v * (width * (vv - 0.5)) + lift * edge
            rows.append((p, (s * repeat, vv)))
        i0 = len(self.verts)
        for p, uv in rows:
            self.verts.append(tuple(p))
            self.uvs.append(uv)
            self.normals.append(n)
        # 0 1 2 at the base, 3 4 5 at the tip.
        self.faces.append((i0 + 0, i0 + 3, i0 + 4, i0 + 1))
        self.faces.append((i0 + 1, i0 + 4, i0 + 5, i0 + 2))

    def strip(self, points, v_dir, width, fold, outs):
        """A card bent along a path: `points` from base to tip, one texture
        tile over its whole length, folded like `card`, with a normal per
        point. A fern frond, arching up out of its crown and over."""
        v = mathutils.Vector(v_dir).normalized()
        total = sum((mathutils.Vector(points[i + 1]) - mathutils.Vector(points[i])).length
                    for i in range(len(points) - 1))
        i0 = len(self.verts)
        run = 0.0
        for k, p in enumerate(points):
            if k:
                run += (mathutils.Vector(p) - mathutils.Vector(points[k - 1])).length
            n = mathutils.Vector(outs[k]).normalized()
            taper = 1.0 - 0.55 * (run / total) ** 2
            for vv in (0.0, 0.5, 1.0):
                edge = abs(vv - 0.5) * 2
                q = mathutils.Vector(p) + v * (width * taper * (vv - 0.5)) + n * (fold * width * 0.5 * edge)
                self.verts.append(tuple(q))
                self.uvs.append((run / total, 0.5 + (vv - 0.5) * taper))
                self.normals.append(n)
        for k in range(len(points) - 1):
            a = i0 + k * 3
            self.faces.append((a + 0, a + 3, a + 4, a + 1))
            self.faces.append((a + 1, a + 4, a + 5, a + 2))

    def mesh(self, name="needles"):
        mesh = lib.bpy.data.meshes.new(name)
        mesh.from_pydata(self.verts, [], self.faces)
        mesh.validate()
        mesh.update()
        layer = mesh.uv_layers.new(name="UVMap")
        for poly in mesh.polygons:
            for li in poly.loop_indices:
                vi = mesh.loops[li].vertex_index
                layer.data[li].uv = self.uvs[vi]
        obj = lib.bpy.data.objects.new(name, mesh)
        lib.bpy.context.collection.objects.link(obj)
        lib.assign(obj, self.mat)
        mark_own_uv(obj)
        obj["crown_normals"] = [c for n in self.normals for c in n]
        return obj


def deliver_conifer(parts, cards_obj, name):
    """`kit.deliver`, except that the cube projection must not touch the
    cards -- their UVs are the spray texture's tile -- nor anything unwrapped
    by `hull`, and the cards' normals are set by hand after the join,
    pointing out of the crown, which is what makes a mass of flat cards light
    like a volume. Every plant with cards goes out through here."""
    normals = cards_obj["crown_normals"]
    n_cards = len(cards_obj.data.vertices)
    parts = [p for p in parts if p is not None]
    for obj in parts:
        lib.apply_modifiers(obj)
    # The cards go first so their vertices keep indices 0..n_cards-1.
    obj = lib.join([cards_obj] + parts, name)
    kit.zero_origin(obj)
    obj.data.name = name
    mesh = obj.data
    lib.bpy.context.view_layer.objects.active = obj
    lib.bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    lib.bpy.ops.object.mode_set(mode="EDIT")
    lib.bpy.ops.mesh.select_all(action="DESELECT")
    lib.bpy.ops.object.mode_set(mode="OBJECT")
    # Read only after the mode switches: edit mode rebuilds the mesh, and a
    # reference taken before it points at whatever landed there instead.
    own = mesh.attributes["own_uv"].data
    for poly in mesh.polygons:
        poly.select = own[poly.index].value == 0
    lib.bpy.ops.object.mode_set(mode="EDIT")
    lib.bpy.ops.uv.cube_project(cube_size=1.0)
    lib.bpy.ops.object.mode_set(mode="OBJECT")
    # Split normals: the crown's for the cards, the mesh's own for the wood.
    for poly in mesh.polygons:
        poly.use_smooth = True
    mesh.attributes.remove(mesh.attributes["own_uv"])
    corner = [tuple(c.vector) for c in mesh.corner_normals]
    custom = []
    for li, loop in enumerate(mesh.loops):
        vi = loop.vertex_index
        if vi < n_cards:
            custom.append(tuple(normals[vi * 3:vi * 3 + 3]))
        else:
            custom.append(corner[li])
    mesh.normals_split_custom_set(custom)
    tris = lib.stats([obj])
    lib.export(name, [obj])
    return "%-16s %5d tris" % (name, tris)


def conifer(name, sp):
    """A coastal conifer, as layered bough whorls carrying needle cards.

    Each bough is a thin branch that leaves the trunk, droops and turns its
    tip up again, and along it lie two to four folded cards of the needle
    spray -- alpha-cut, so there is sky between the sprays and the crown has a
    ragged edge instead of a faceted one. The tiers overlap enough that the
    crown reads dark from outside and its edge reads as foliage. Every spray
    gets a normal pointing out of the crown from the trunk axis, so the tree
    is lit as one soft volume with a sunlit side and a shaded side, not as
    two hundred flat plates catching the sun one by one.

    What separates the species is the numbers: the Douglas-fir's straight
    spire and upturned bough tips, the hemlock's nodding leader and fine,
    pendulous sprays, the cedar's buttressed base, J-shaped limbs and
    curtains of spray hanging off them."""
    lib.reset()
    rng = random.Random(sp["seed"])
    parts = []
    cards = Cards()
    H = sp["H"]
    r0 = sp["r0"]
    # Trunk: a closed hull, flared at the foot, tapering to the leader.
    # Sixteen sides, smooth-shaded and unwrapped as a cylinder: at nine, with
    # cube-projected bark, every facet was a flat plank of its own.
    sides = 16
    wob = [0.035 * math.sin(2 * math.pi * i / sides * 3 + 0.7) + rng.uniform(-0.02, 0.02) for i in range(sides)]
    rings = [(0.0, r0 * sp.get("flare", 1.25), 0, 0), (0.45, r0 * 1.05, 0, 0),
             (H * 0.25, r0 * 0.86, 0, 0), (H * 0.55, r0 * 0.6, 0, 0),
             (H * 0.8, r0 * 0.34, 0, 0), (H * 0.97, r0 * 0.08, 0, 0)]
    parts.append(hull(rings, sides, wob, mat=sp["bark"], name="trunk", unwrap=True))
    if sp.get("buttress"):
        for i in range(5):
            a = 2 * math.pi * (i + 0.2) / 5
            parts.append(segment((math.cos(a) * r0 * 0.7, math.sin(a) * r0 * 0.7, 0.0),
                                 (math.cos(a) * 0.55, math.sin(a) * 0.55, 1.0), 1.5,
                                 r0 * 0.45, 0.05, verts=4, name="buttress", mat=sp["bark"]))
    # Dead stubs on the bare lower bole.
    z_crown = H * sp["crown_base"]
    for i in range(sp.get("stubs", 3)):
        a = 2.1 * i + 0.6
        z = 1.4 + (z_crown - 1.8) * (i + 0.5) / max(1, sp.get("stubs", 3))
        parts.append(segment((0, 0, z), (math.cos(a), math.sin(a), -0.3), 0.55 + 0.15 * (i % 2),
                             0.06, 0.012, verts=3, name="stub", mat=sp["bark"]))

    tiers = sp["tiers"]
    spray_w = sp["spray_w"]
    for w in range(tiers):
        t = w / (tiers - 1.0)                       # 0 at the lowest live tier
        z = z_crown + (H * 0.94 - z_crown) * t ** sp.get("tier_power", 1.0) + rng.uniform(-0.12, 0.12)
        reach = sp["R"] * sp["profile"](t) + 0.25
        n = max(3, int(round(sp["n0"] + (sp["n1"] - sp["n0"]) * t)))
        for i in range(n):
            if 0 < w < tiers - 2 and rng.random() < 0.06:
                continue
            a = 2 * math.pi * (i + rng.uniform(-0.2, 0.2)) / n + w * 2.39996
            L = reach * rng.uniform(0.85, 1.1)
            c, s_ = math.cos(a), math.sin(a)
            radial = mathutils.Vector((c, s_, 0.0))
            up = mathutils.Vector((0, 0, 1))
            side = mathutils.Vector((-s_, c, 0.0))
            droop = sp["droop"] * (1.0 - 0.6 * t)
            upturn = sp["upturn"]

            def at(q):
                # Out along the radial, falling with the square of the
                # distance, turning up again near the tip.
                return (radial * (L * q)
                        + up * (L * (sp["rise"] * q - droop * q * q + upturn * max(0.0, q - 0.55) ** 2 * 2.2))
                        + mathutils.Vector((0, 0, z)))

            p0, p1, p2 = at(0.0), at(0.5), at(1.0)
            if L > 0.9:
                parts.append(segment(tuple(p0), tuple(p1 - p0), (p1 - p0).length, 0.05 + L * 0.012, 0.02,
                                     verts=3, name="bough", mat=sp["bark"]))
                parts.append(segment(tuple(p1), tuple(p2 - p1), (p2 - p1).length, 0.02, 0.006,
                                     verts=3, name="bough", mat=sp["bark"]))
            k_cards = 2 if L < 1.1 else (3 if L < 2.2 else 4)
            for k in range(k_cards):
                q0 = 0.08 + k * (0.86 / k_cards) + rng.uniform(-0.04, 0.04)
                q1 = min(1.08, q0 + 0.86 / k_cards + 0.2)
                a0, a1 = at(q0), at(q1)
                length = (a1 - a0).length * 1.05
                width = spray_w * (1.0 - 0.35 * q0) * (0.75 + 0.5 * min(1.0, L / 2.5)) * rng.uniform(0.85, 1.15)
                # Roll each spray a little about the bough, so no two lie flat
                # in the same plane.
                roll = rng.uniform(-0.45, 0.45)
                v_dir = side * math.cos(roll) + up * math.sin(roll)
                u_dir = (a1 - a0)
                mid = (a0 + a1) * 0.5
                out = (mathutils.Vector((mid.x, mid.y, 0)).normalized() * 0.8
                       + up * (0.55 + 0.3 * (mid.z - H * 0.5) / H))
                cards.card(a0, u_dir, v_dir, length, width, sp["fold"], out)
            # Curtains: sprays hanging straight down off the bough, the cedar's
            # lace and the hemlock's weeping tips.
            if rng.random() < sp.get("curtains", 0.0) and L > 0.8:
                for q in (0.45, 0.8):
                    hp = at(q)
                    hang = sp.get("hang", 1.0) * (0.7 + 0.5 * rng.random()) * min(1.0, L / 2.0)
                    face = side * math.cos(0.3) + radial * math.sin(0.3)
                    out = radial * 0.9 + up * 0.2
                    cards.card(hp + up * 0.05, (0, 0, -1), face, hang, spray_w * 0.75, 0.25, out)

    # The leader: a spire of short sprays, and for the hemlock a tip that nods.
    top = mathutils.Vector((0, 0, H * 0.94))
    lean = mathutils.Vector(sp.get("nod", (0.0, 0.0, 1.0))).normalized()
    parts.append(segment(tuple(top), tuple(lean), H * 0.08, r0 * 0.1, 0.01, verts=4, name="leader", mat=sp["bark"]))
    for i in range(4):
        a = 2 * math.pi * i / 4 + 0.4
        d = mathutils.Vector((math.cos(a), math.sin(a), 0))
        base = top + lean * (H * 0.03 * (i % 2))
        cards.card(base, d * 0.7 + lean * 0.7, (-math.sin(a), math.cos(a), 0), H * 0.07, spray_w * 0.6, 0.3,
                   d * 0.6 + mathutils.Vector((0, 0, 0.8)))
    cards.card(top + lean * (H * 0.02), lean, (1, 0, 0), H * 0.07, spray_w * 0.45, 0.2, (0.3, 0.3, 1.0))
    cards.card(top + lean * (H * 0.02), lean, (0, 1, 0), H * 0.07, spray_w * 0.45, 0.2, (0.3, -0.3, 1.0))
    return deliver_conifer(parts, cards.mesh(), name)


# Crown profiles: reach as a function of height up the live crown (0..1).
def _fir_profile(t):
    # Widest a fifth of the way up, the lowest tier a little shorter (shaded
    # out), then a long straight taper to the spire.
    return (0.82 + 0.9 * t if t < 0.2 else 1.0) * (1.0 - t) ** 0.9 + 0.05


def _hemlock_profile(t):
    return (1.0 - t) ** 0.8 * (0.85 + 0.15 * math.sin(t * 7.0)) + 0.06


def _cedar_profile(t):
    # Broad, irregular, with a rounded shoulder high up.
    return (1.0 - t ** 1.6) * (0.9 + 0.1 * math.sin(t * 11.0)) + 0.05


DOUGLAS = dict(seed=70016, H=17.0, r0=0.46, bark="firbark", crown_base=0.24, R=3.3,
               profile=_fir_profile, tiers=15, n0=7, n1=4, droop=0.34, upturn=0.28,
               rise=0.06, spray_w=0.85, fold=0.32, curtains=0.0, stubs=4)
HEMLOCK = dict(seed=70013, H=12.5, r0=0.3, bark="firbark", crown_base=0.14, R=2.7,
               profile=_hemlock_profile, tiers=13, n0=7, n1=4, droop=0.5, upturn=0.08,
               rise=0.0, spray_w=0.8, fold=0.22, curtains=0.35, hang=0.9, stubs=2,
               nod=(0.55, 0.2, 0.7))
CEDAR = dict(seed=70021, H=15.0, r0=0.58, bark="cedarbark", crown_base=0.18, R=3.6,
             profile=_cedar_profile, tiers=12, n0=7, n1=4, droop=0.62, upturn=0.34,
             rise=0.1, spray_w=0.95, fold=0.18, curtains=0.6, hang=1.4, stubs=2,
             buttress=True, flare=1.6, tier_power=0.9)


def build_tree_fir():
    """A Douglas-fir, 17 m: see `conifer`."""
    return conifer("tree_fir", DOUGLAS)


def build_tree_cedar():
    """A western red cedar, 15 m: see `conifer`."""
    return conifer("tree_cedar", CEDAR)


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
    objs = [hull(rings, sides, wob, jag, mat="bark", name="spar", unwrap=True)]
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
    """A sword fern, 0.7 m out of a crown and a metre and a half across.

    Twelve fronds, each one alpha-cut card bent along an arc: steeply up out of
    the crown and bowing over past halfway, so the clump is a shuttlecock and
    not a yucca, with the pinnae in the texture. They were lofted solid
    blades -- green straps, nothing pinnate about them."""
    lib.reset()
    rng = random.Random(70018)
    objs = [hull([(0.00, 0.07, 0, 0), (0.05, 0.09, 0, 0), (0.1, 0.04, 0, 0)],
                 5, mat="bark", name="crown")]
    cards = Cards("fernleaf", tile=1.0)
    for i in range(12):
        a = 2 * math.pi * i / 12 + rng.uniform(-0.25, 0.25)
        L = rng.uniform(0.7, 1.0)
        rise = rng.uniform(0.95, 1.25)    # how steeply it leaves the crown
        bow = rng.uniform(1.7, 2.3)       # how far it has turned by the tip
        radial = mathutils.Vector((math.cos(a), math.sin(a), 0))
        up = mathutils.Vector((0, 0, 1))
        pts, outs = [], []
        p = mathutils.Vector((math.cos(a) * 0.05, math.sin(a) * 0.05, 0.1))
        n = 5
        for k in range(n + 1):
            t = k / n
            ang = rise - bow * t * t
            pts.append(tuple(p))
            direction = radial * math.cos(ang) + up * math.sin(ang)
            outs.append(tuple((up * 0.8 + radial * 0.35 - direction * 0.2)))
            p = p + direction * (L / n)
        roll = rng.uniform(-0.35, 0.35)
        v = mathutils.Vector((-math.sin(a), math.cos(a), 0)) * math.cos(roll) + up * math.sin(roll)
        cards.strip(pts, v, 0.32, 0.3, outs)
    return deliver_conifer(objs, cards.mesh("fronds"), "fern")


def build_salal_bush():
    """Salal: 0.75 m high and twice that across, which is the whole difference
    between it and `bush` -- that one is a shrub with a shape, this is a
    thicket. Arching stems carrying the big, glossy, pointed leaf you can name
    salal by from a metre away, alpha-cut sprays of them fanned out low over
    the ground."""
    lib.reset()
    rng = random.Random(70019)
    objs = []
    cards = Cards("salal", tile=0.9)
    for i in range(7):
        a = 2 * math.pi * i / 7 + 0.2
        objs.append(segment((math.cos(a) * 0.07, math.sin(a) * 0.07, 0),
                            (math.cos(a) * 0.62, math.sin(a) * 0.62, 1.0),
                            0.46 + 0.1 * (i % 3), 0.035, 0.014, verts=4, name="stem"))
    centre = mathutils.Vector((0.0, 0.0, 0.2))
    for k in range(26):
        a = k * 2.39996 + rng.uniform(-0.25, 0.25)
        e = rng.uniform(0.15, 0.75) if k % 3 else rng.uniform(0.7, 1.1)
        u = mathutils.Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))
        base = mathutils.Vector((math.cos(a) * rng.uniform(0.05, 0.3), math.sin(a) * rng.uniform(0.05, 0.3),
                                 rng.uniform(0.04, 0.2)))
        side = u.cross(mathutils.Vector((0, 0, 1)))
        if side.length < 1e-3:
            side = mathutils.Vector((1, 0, 0))
        roll = rng.uniform(-0.5, 0.5)
        v = side.normalized() * math.cos(roll) + u.cross(side).normalized() * math.sin(roll)
        length = rng.uniform(0.55, 0.85)
        cards.card(base, u, v, length, rng.uniform(0.4, 0.5), 0.2, outward(base + u * length * 0.5, centre, 0.6))
    return deliver_conifer(objs, cards.mesh("leaves"), "salal_bush")


def build_moss_rock():
    """A boulder 0.9 m over, mossed in the shader.

    The moss used to be a second shell over the top of the stone, and however
    ragged its hem, a shell has an edge: a judge saw a flat green lid on every
    boulder in Haon Dor. The `mossrock` material grows moss over whatever
    faces the sky and the north instead, with a soft wandering edge, so the
    stone only has to be a stone: a rounded, lopsided hull, smooth-shaded,
    with a few flatter fracture faces knocked into it."""
    lib.reset()
    rng = random.Random(70020)
    sides = 14
    wob = [rng.uniform(-0.09, 0.11) for _ in range(sides)]
    # Two flats round the side, where a face split off along a joint.
    for k in (rng.randrange(sides), rng.randrange(sides)):
        for d in (-1, 0, 1):
            wob[(k + d) % sides] = min(wob[(k + d) % sides], -0.12 + 0.03 * abs(d))
    rock = [(0.00, 0.44, 0.00, 0.00), (0.10, 0.53, 0.01, 0.00), (0.26, 0.57, 0.02, 0.01),
            (0.44, 0.54, 0.04, -0.01), (0.62, 0.45, 0.06, -0.02), (0.78, 0.31, 0.08, -0.03),
            (0.88, 0.16, 0.09, -0.02), (0.92, 0.04, 0.09, -0.02)]
    stone = hull(rock, sides, wob, mat="mossrock", name="boulder")
    lib.shade_smooth(stone)
    return kit.deliver([stone], "moss_rock")


ASSETS = [build_tree_oak, build_tree_pine, build_tree_fir, build_tree_cedar, build_tree_snag,
          build_bush, build_salal_bush, build_fern, build_moss_rock,
          build_grass_tuft, build_hedge_clump, build_hedge_row]


def build():
    return "\n".join(fn() for fn in ASSETS)
