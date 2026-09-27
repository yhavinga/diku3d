"""weapons -- the arms a mobile carries, and the player's first-person weapon.

Every one of these is authored in the same frame, so a hand can take any of
them without a per-weapon offset table:

* The origin is the centre of the grip -- the point inside a closed fist.
* +Z (three's +Y) runs along the weapon from the hand towards the business
  end: up the blade, up the haft, up the shaft.
* -Y (three's +Z) is the striking side: the edge of a sword, the bit of an
  axe, the face of a shield. For a figure that faces -Y, a weapon held
  point-up in front of it shows its edge to whoever it is facing.
* Flats face +-X.

Shields put the grip at the origin and their face at -Y, so a shield held on a
forearm that hangs at the side faces forward.

Materials: `steel` is a bright polished recipe of its own -- `iron` is the dark
hot-worked iron of a door strap and a blade in it reads as a stick of charcoal
-- `iron` is kept for guards, pommels, bosses and fittings, which are dark
iron on a real weapon too. `oak` for hafts and boards, `leather` for grips and
rims. A shield's face is `paint`, a flat material the viewer tints per mobile
so a watch can carry the town's colours.
"""

import math
import importlib

import bpy

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)


def smooth(obj):
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def rod(z0, z1, r0, r1, sides=8, mat="oak", name="rod", rings=None):
    """A round member along Z. `rings` adds intermediate (z, r) stations."""
    secs = [(z0, r0, r0, 0.0, 0.0)]
    for (z, r) in (rings or []):
        secs.append((z, r, r, 0.0, 0.0))
    secs.append((z1, r1, r1, 0.0, 0.0))
    return smooth(lib.loft(secs, sides=sides, name=name, mat=mat))


def blade(stations, thick, mat="steel", name="blade", sides=6):
    """A double-edged blade: (z, half-width) stations, lenticular section. Six
    sides puts a ridge down each flat and an edge each side -- the two lines
    that catch the light on a real blade -- for 12 triangles a band."""
    secs = [(z, thick * (1.0 if w > 0.004 else 0.4), max(w, 0.0015), 0.0, 0.0)
            for (z, w) in stations]
    return lib.loft(secs, sides=sides, name=name, mat=mat)


def sweep(points, half_w, half_d, mat="iron", name="band"):
    """A closed band of rectangular section following a closed loop of points
    that lies roughly in an XZ plane: `half_w` in the plane of the loop,
    `half_d` across it (along Y)."""
    import mathutils
    n = len(points)
    verts, faces = [], []
    for i in range(n):
        a = mathutils.Vector(points[i - 1])
        b = mathutils.Vector(points[i])
        c = mathutils.Vector(points[(i + 1) % n])
        t = (c - a).normalized()
        across = mathutils.Vector((0.0, 1.0, 0.0))
        out = t.cross(across).normalized()
        for (u, v) in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
            verts.append(tuple(b + out * (u * half_w) + across * (v * half_d)))
    for i in range(n):
        j = (i + 1) % n
        for k in range(4):
            l = (k + 1) % 4
            faces.append((i * 4 + k, i * 4 + l, j * 4 + l, j * 4 + k))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, mat)
    return _outward(obj)


def grip(z0, z1, r=0.016, mat="leather", wraps=0):
    """An oval grip, a little fuller in the middle where the palm closes."""
    zm = (z0 + z1) / 2
    secs = [(z0, r * 0.86, r, 0.0, 0.0), (zm, r * 1.08, r * 1.2, 0.0, 0.0),
            (z1, r * 0.86, r, 0.0, 0.0)]
    return smooth(lib.loft(secs, sides=8, name="grip", mat=mat))


# --- the weapons -----------------------------------------------------------

def build_sword():
    """An arming sword, 0.96 m overall: the one-hander of every watch and
    garrison in the period. Straight cruciform guard, wheel pommel."""
    lib.reset()
    p = []
    p.append(blade([(0.070, 0.024), (0.12, 0.024), (0.45, 0.020), (0.68, 0.015),
                    (0.77, 0.008), (0.815, 0.001)], 0.0042))
    # Ricasso: the unsharpened square shoulder where the blade meets the guard.
    p.append(kit.timber((0.012, 0.050, 0.03), (0, 0, 0.078), (0, 0, 0), "steel", 0.003, "ricasso"))
    # The guard runs along the edges (Y) and droops a little at each end.
    for sy in (-1, 1):
        p.append(kit.timber((0.016, 0.105, 0.016), (0, sy * 0.050, 0.060),
                            (sy * math.radians(8), 0, 0), "iron", 0.005, "quillon"))
        p.append(lib.sphere(0.011, (0, sy * 0.104, 0.068), 8, 5, name="quillon_end", mat="iron"))
    p.append(kit.timber((0.024, 0.030, 0.026), (0, 0, 0.058), (0, 0, 0), "iron", 0.006, "guard_block"))
    p.append(grip(-0.050, 0.050, r=0.0145))
    # Wheel pommel: a disc on edge in the plane of the blade.
    pom = lib.cylinder(0.026, 0.022, (0, 0, -0.074), (0, math.radians(90), 0), verts=12,
                       name="pommel", mat="iron")
    smooth(pom)
    p.append(pom)
    p.append(lib.cylinder(0.009, 0.03, (0, 0, -0.074), (0, math.radians(90), 0), verts=8,
                          name="pommel_boss", mat="iron"))
    return kit.deliver(p, "weapon_sword")


def build_dagger():
    """A rondel-less ballock-free plain dagger, 0.36 m: something a thief or a
    drunk would have on his belt."""
    lib.reset()
    p = []
    p.append(blade([(0.052, 0.017), (0.10, 0.015), (0.20, 0.010), (0.255, 0.004),
                    (0.275, 0.001)], 0.0045))
    for sy in (-1, 1):
        p.append(kit.timber((0.013, 0.050, 0.013), (0, sy * 0.022, 0.044),
                            (sy * math.radians(10), 0, 0), "iron", 0.004, "quillon"))
    p.append(grip(-0.045, 0.040, r=0.0125, mat="oak"))
    pom = lib.sphere(0.018, (0, 0, -0.056), 10, 6, name="pommel", mat="iron")
    pom.scale = (0.8, 1.0, 0.9)
    smooth(pom)
    p.append(pom)
    return kit.deliver(p, "weapon_dagger")


def build_axe():
    """A bearded hand-axe on a 0.78 m haft, gripped near the foot of it. The
    head is a real shape rather than a wedge: a thin cheek that flares into a
    long curved bit, a beard hooking down behind the edge, and a poll."""
    lib.reset()
    p = []
    p.append(rod(-0.14, 0.64, 0.017, 0.015, sides=8, name="haft",
                 rings=[(-0.12, 0.019), (0.10, 0.017), (0.52, 0.016)]))
    # The head, lofted along -Y (towards the edge) as a stack of vertical
    # sections: eye, neck, and a bit that grows downward into the beard.
    zc = 0.575
    secs = []
    # The top edge runs nearly level off the eye; all the growth is downward,
    # into the beard, which is what tells a bearded axe from a woodsman's.
    for (y, top, bot, half) in ((0.032, 0.034, -0.034, 0.017),      # poll
                                (0.000, 0.046, -0.046, 0.022),      # over the eye
                                (-0.030, 0.036, -0.036, 0.011),     # neck
                                (-0.070, 0.036, -0.060, 0.007),
                                (-0.110, 0.042, -0.102, 0.0045),
                                (-0.142, 0.048, -0.132, 0.0025),    # the bit
                                (-0.150, 0.044, -0.126, 0.0010)):
        secs.append((y, top, bot, half))
    verts, faces = [], []
    for (y, top, bot, half) in secs:
        mid = (top + bot) / 2
        # Six points: a lenticular section, thicker at the middle than at
        # either end, so the cheek has a ridge for the light to run along.
        ring = [(half * 0.55, y, zc + top), (-half * 0.55, y, zc + top),
                (-half, y, zc + mid), (-half * 0.55, y, zc + bot),
                (half * 0.55, y, zc + bot), (half, y, zc + mid)]
        verts.extend(ring)
    n = 6
    for k in range(len(secs) - 1):
        b = k * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((b + i, b + j, b + j + n, b + i + n))
    faces.append(tuple(range(n)))
    faces.append(tuple(range(len(verts) - 1, len(verts) - n - 1, -1)))
    mesh = bpy.data.meshes.new("axe_head")
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    head = bpy.data.objects.new("axe_head", mesh)
    bpy.context.collection.objects.link(head)
    lib.assign(head, "steel")
    _outward(head)
    p.append(head)
    # A wrap of leather where the hand goes, and an iron wedge showing on top.
    p.append(grip(-0.10, 0.02, r=0.0185))
    p.append(kit.timber((0.012, 0.030, 0.012), (0, 0.0, 0.632), (0, 0, 0), "iron", 0.003, "wedge"))
    return kit.deliver(p, "weapon_axe")


def _outward(obj):
    """Recalculate normals outward -- the hand-built loft above is closed but
    its winding was written for legibility, not for the renderer."""
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def build_mace():
    """A flanged mace, 0.62 m: seven iron flanges round a socket on an iron-
    shod oak haft. The flanges are what make it read as a mace and not a club
    at ten metres -- a ball on a stick is a torch."""
    lib.reset()
    p = []
    p.append(rod(-0.10, 0.44, 0.016, 0.017, sides=8, name="haft", rings=[(0.20, 0.0155)]))
    p.append(grip(-0.085, 0.07, r=0.018))
    p.append(rod(0.38, 0.54, 0.022, 0.020, sides=10, mat="iron", name="socket"))
    p.append(rod(0.535, 0.56, 0.020, 0.008, sides=10, mat="iron", name="finial"))
    for i in range(7):
        a = 2 * math.pi * i / 7
        # Each flange is a slab standing out from the socket, deepest in the
        # middle of its length and tapering to both ends.
        fl = lib.loft([(0.405, 0.004, 0.006, 0.0, 0.0), (0.44, 0.004, 0.034, 0.0, 0.0),
                       (0.50, 0.004, 0.036, 0.0, 0.0), (0.535, 0.004, 0.010, 0.0, 0.0)],
                      sides=4, name="flange", mat="steel")
        for v in fl.data.vertices:
            v.co.y = abs(v.co.y) + 0.018 if v.co.y > 0 else 0.018 + v.co.y * 0.2
        fl.rotation_euler = (0, 0, a)
        p.append(fl)
    p.append(lib.torus(0.019, 0.004, (0, 0, -0.10), major_seg=10, minor_seg=4,
                       name="butt_ring", mat="iron"))
    return kit.deliver(p, "weapon_mace")


def build_spear():
    """A 2.2 m infantry spear: ash shaft, leaf-shaped blade on a socket, iron
    butt cap. Held a third of the way up, which is where a man carrying one
    upright takes it -- the butt then clears the ground by a hand."""
    lib.reset()
    p = []
    p.append(rod(-0.86, 1.14, 0.017, 0.015, sides=8, name="shaft",
                 rings=[(-0.3, 0.0175), (0.6, 0.016)]))
    p.append(rod(-0.93, -0.84, 0.012, 0.019, sides=8, mat="iron", name="butt"))
    p.append(rod(1.12, 1.21, 0.019, 0.013, sides=8, mat="iron", name="socket"))
    p.append(blade([(1.20, 0.012), (1.25, 0.030), (1.31, 0.032), (1.38, 0.022),
                    (1.44, 0.009), (1.47, 0.001)], 0.0055, name="head"))
    # Two rivets through the socket, and a binding below it.
    p.append(lib.cylinder(0.005, 0.042, (0, 0, 1.15), (0, math.radians(90), 0), verts=6,
                          name="rivet", mat="iron"))
    p.append(rod(1.04, 1.10, 0.0175, 0.0175, sides=8, mat="leather", name="binding"))
    return kit.deliver(p, "weapon_spear")


def build_staff():
    """A walking staff, 1.8 m, gripped at shoulder height of a man leaning on
    it. Not a rod: it swells and wanders where the branch did, and the top is
    a knot a hand could close over."""
    lib.reset()
    p = []
    rings = []
    for k in range(12):
        z = -1.02 + k * 0.155
        wander = 0.006 * math.sin(k * 1.7)
        r = 0.018 + 0.004 * math.sin(k * 2.3 + 0.6)
        rings.append((z, r, r * 1.08, wander, 0.004 * math.cos(k * 1.3)))
    shaft = lib.loft(rings + [(0.70, 0.022, 0.023, 0.0, 0.0)], sides=8, name="staff", mat="oak")
    smooth(shaft)
    p.append(shaft)
    knot = lib.loft([(0.69, 0.023, 0.023, 0.0, 0.0), (0.73, 0.034, 0.030, 0.004, -0.004),
                     (0.78, 0.038, 0.034, 0.008, -0.006), (0.83, 0.028, 0.026, 0.006, -0.002),
                     (0.855, 0.010, 0.010, 0.002, 0.0)], sides=8, name="knot", mat="oak")
    smooth(knot)
    p.append(knot)
    p.append(rod(-1.08, -1.0, 0.014, 0.020, sides=8, mat="iron", name="ferrule"))
    p.append(rod(0.02, 0.10, 0.021, 0.021, sides=8, mat="leather", name="wrap"))
    return kit.deliver(p, "weapon_staff")


def build_shield_round():
    """A 0.76 m round shield of butt-jointed boards behind a painted face, an
    iron boss and a rawhide rim. Grip at the origin, face towards -Y."""
    lib.reset()
    p = []
    R = 0.38
    face_y = -0.045
    # Six boards, each the chord of the circle it lies on, with a hair of
    # gap between them so the joints read under a raking light.
    n = 6
    w = 2 * R / n
    for i in range(n):
        x0 = -R + i * w + 0.002
        x1 = x0 + w - 0.004
        pts = []
        steps = 6
        for s in range(steps + 1):
            x = x0 + (x1 - x0) * s / steps
            h = math.sqrt(max(R * R - x * x, 0.0)) - 0.004
            pts.append((x, h))
        verts, faces = [], []
        for (x, h) in pts:
            # Slight dish: the face comes forward towards the middle.
            dish = 0.018 * (1 - (x / R) ** 2)
            verts += [(x, face_y - dish, h), (x, face_y - dish, -h),
                      (x, face_y - dish + 0.012, h), (x, face_y - dish + 0.012, -h)]
        m = len(pts)
        for k in range(m - 1):
            a, b = 4 * k, 4 * (k + 1)
            faces.append((a, b, b + 1, a + 1))           # front
            faces.append((a + 2, a + 3, b + 3, b + 2))   # back
            faces.append((a, a + 2, b + 2, b))           # top edge
            faces.append((a + 1, b + 1, b + 3, a + 3))   # bottom edge
        faces.append((0, 1, 3, 2))
        e = 4 * (m - 1)
        faces.append((e, e + 2, e + 3, e + 1))
        mesh = bpy.data.meshes.new("board")
        mesh.from_pydata(verts, [], faces)
        mesh.validate()
        board = bpy.data.objects.new("board", mesh)
        bpy.context.collection.objects.link(board)
        lib.assign(board, "paint")
        _outward(board)
        p.append(board)
    rim = lib.torus(R, 0.010, (0, face_y + 0.004, 0), (math.radians(90), 0, 0),
                    major_seg=24, minor_seg=4, name="rim", mat="leather")
    rim.scale = (1.0, 1.0, 1.6)
    smooth(rim)
    p.append(rim)
    boss = lib.sphere(0.085, (0, face_y - 0.012, 0), 12, 5, name="boss", mat="iron")
    boss.scale = (1.0, 0.55, 1.0)
    smooth(boss)
    p.append(boss)
    p.append(lib.torus(0.088, 0.008, (0, face_y - 0.018, 0), (math.radians(90), 0, 0),
                       major_seg=12, minor_seg=3, name="boss_flange", mat="iron"))
    # The grip behind the boss, across the shield, and a pair of board
    # battens behind it that stiffen the boards and show from behind.
    # Grip and battens in leather-wrapped wood: one material fewer to draw,
    # and they are only ever seen from behind the shield.
    p.append(kit.timber((0.20, 0.028, 0.028), (0, -0.010, 0), (0, 0, 0), "leather", 0.006, "grip"))
    for sz in (-1, 1):
        p.append(kit.timber((0.64, 0.016, 0.05), (0, -0.026, sz * 0.15), (0, 0, 0),
                            "leather", 0.004, "batten"))
    return kit.deliver(p, "shield_round")


def build_shield_kite():
    """A kite shield, 0.92 m by 0.52, curved round the body. Painted face,
    iron-bound edge, a grip and a forearm strap behind. The origin is the
    grip, a third of the way down, which is where the arm goes through."""
    lib.reset()
    p = []
    top, bottom = 0.34, -0.58
    half_w = 0.26
    bulge = 0.075           # depth of the curve across the face
    rows = 12
    cols = 9
    face_y = -0.05

    def outline(z):
        # Straight-sided in the top third, then the long taper to the point.
        if z > 0.08:
            return half_w
        t = (z - bottom) / (0.08 - bottom)
        return half_w * math.sin(t * math.pi / 2) ** 0.9

    def surface(u, z, dy):
        x = u * outline(z)
        # Curved round the bearer: edges swept back, the centre forward.
        y = face_y - bulge * (1 - (x / half_w) ** 2) + dy
        return (x, y, z)

    verts = []
    zs = [top - (top - bottom) * r / rows for r in range(rows + 1)]
    for layer, dy in ((0, 0.0), (1, 0.012)):
        for z in zs:
            for c in range(cols + 1):
                u = -1 + 2 * c / cols
                verts.append(surface(u, z, dy))
    stride = cols + 1
    off = (rows + 1) * stride
    faces = []
    for r in range(rows):
        for c in range(cols):
            a = r * stride + c
            faces.append((a, a + 1, a + 1 + stride, a + stride))
            faces.append((off + a, off + a + stride, off + a + 1 + stride, off + a + 1))
    # Close the rim.
    border = ([c for c in range(cols + 1)] +
              [r * stride + cols for r in range(1, rows + 1)] +
              [rows * stride + c for c in range(cols - 1, -1, -1)] +
              [r * stride for r in range(rows - 1, 0, -1)])
    for i in range(len(border)):
        a, b = border[i], border[(i + 1) % len(border)]
        faces.append((a, off + a, off + b, b))
    mesh = bpy.data.meshes.new("kite")
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    body = bpy.data.objects.new("kite", mesh)
    bpy.context.collection.objects.link(body)
    lib.assign(body, "paint")
    _outward(body)
    smooth(body)
    p.append(body)
    # The iron binding round the edge: one continuous band swept round the
    # outline. Timbers laid segment by segment stepped at every joint like a
    # staircase.
    loop = [surface(1.0, z, 0.006) for z in zs] + [surface(-1.0, z, 0.006) for z in reversed(zs)]
    dedup = [loop[0]]
    for q in loop[1:]:
        if math.dist(q, dedup[-1]) > 1e-4:
            dedup.append(q)
    if math.dist(dedup[0], dedup[-1]) < 1e-4:
        dedup.pop()
    p.append(sweep(dedup, 0.011, 0.014, mat="iron", name="binding"))
    # Small boss low on the face, and the grip and strap behind.
    boss = lib.sphere(0.05, (0, face_y - bulge - 0.004, 0.02), 12, 6, name="boss", mat="iron")
    boss.scale = (1.0, 0.5, 1.0)
    smooth(boss)
    p.append(boss)
    p.append(kit.timber((0.028, 0.026, 0.16), (0, -0.012, 0), (0, 0, 0), "leather", 0.006, "grip"))
    p.append(kit.timber((0.03, 0.012, 0.20), (0, -0.030, 0.18), (0, 0, 0), "leather", 0.003,
                        "strap"))
    return kit.deliver(p, "shield_kite")


ASSETS = [build_sword, build_dagger, build_axe, build_mace, build_spear, build_staff,
          build_shield_round, build_shield_kite]


def build():
    return "\n".join(fn() for fn in ASSETS)


def render(path="/tmp/humans-weapons.png"):
    """Every weapon in a row, standing on its butt, lit from the side."""
    names = ["weapon_sword", "weapon_dagger", "weapon_axe", "weapon_mace", "weapon_spear",
             "weapon_staff", "shield_round", "shield_kite"]
    import os
    lib.reset()
    for i, name in enumerate(names):
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(lib.ASSETS, "%s.glb" % name))
        for obj in set(bpy.context.scene.objects) - before:
            if obj.parent is None:
                obj.location.x += (i - 3.5) * 0.42
                obj.location.z += 1.1
    kit.rake(azim=40, elev=35, strength=4.0, fill=0.35)
    return kit.shot(path, center=(0, 0, 1.2), dist=4.6, azim=-18, elev=6, lens=40, samples=16)
