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
    """A western hemlock, 12 m: see `conifer`. The name is the library's, from
    when this was a pine; parks and forests both place it."""
    return conifer("tree_pine", HEMLOCK)


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


# --- the conifers -----------------------------------------------------------

class Cards:
    """Needle-spray cards collected into one mesh: positions, per-corner UVs
    (the card is the whole texture tile, 0..1) and a per-vertex normal that
    points out of the crown rather than off the card."""

    def __init__(self):
        self.verts, self.faces, self.uvs, self.normals = [], [], [], []

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
        # One spray of the texture per 0.6 m of card, not one per card: a
        # single two-metre spray is a fern frond, not a fir bough.
        repeat = max(1.0, round(length / 0.6))
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
        lib.assign(obj, "needles")
        obj["crown_normals"] = [c for n in self.normals for c in n]
        return obj


def deliver_conifer(parts, cards_obj, name):
    """`kit.deliver`, except that the cube projection must not touch the
    cards -- their UVs are the spray texture's tile -- and the cards' normals
    are set by hand after the join, pointing out of the crown, which is what
    makes a mass of flat cards light like a volume."""
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
    needle_slot = next(i for i, m in enumerate(mesh.materials) if m.name == "MAT:needles")
    lib.bpy.context.view_layer.objects.active = obj
    lib.bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    lib.bpy.ops.object.mode_set(mode="EDIT")
    lib.bpy.ops.mesh.select_all(action="DESELECT")
    lib.bpy.ops.object.mode_set(mode="OBJECT")
    for poly in mesh.polygons:
        poly.select = poly.material_index != needle_slot
    lib.bpy.ops.object.mode_set(mode="EDIT")
    lib.bpy.ops.uv.cube_project(cube_size=1.0)
    lib.bpy.ops.object.mode_set(mode="OBJECT")
    # Split normals: the crown's for the cards, the mesh's own for the wood.
    for poly in mesh.polygons:
        poly.use_smooth = True
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
    sides = 9
    wob = [rng.uniform(-0.05, 0.05) for _ in range(sides)]
    rings = [(0.0, r0 * sp.get("flare", 1.25), 0, 0), (0.45, r0 * 1.05, 0, 0),
             (H * 0.25, r0 * 0.86, 0, 0), (H * 0.55, r0 * 0.6, 0, 0),
             (H * 0.8, r0 * 0.34, 0, 0), (H * 0.97, r0 * 0.08, 0, 0)]
    parts.append(hull(rings, sides, wob, mat=sp["bark"], name="trunk"))
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
    tip = top + lean * (H * 0.08)
    cards.card(top + lean * (H * 0.02), lean, (1, 0, 0), H * 0.07, spray_w * 0.45, 0.2, (0.3, 0.3, 1.0))
    cards.card(top + lean * (H * 0.02), lean, (0, 1, 0), H * 0.07, spray_w * 0.45, 0.2, (0.3, -0.3, 1.0))
    del tip
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


ASSETS = [build_tree_oak, build_tree_pine, build_tree_fir, build_tree_cedar, build_tree_snag,
          build_bush, build_salal_bush, build_fern, build_moss_rock,
          build_grass_tuft]


def build():
    return "\n".join(fn() for fn in ASSETS)
