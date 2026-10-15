"""outfits -- what the people in people.py wear, as geometry.

Four kinds of piece, each weighted the way that kind of thing moves:

* `shell` -- a close-fitting garment cut out of the body's own surface and
  pushed out along the normals: hose, a tunic's body and sleeves, a mail
  shirt, a boot. It carries the body's weights vertex for vertex, so it bends
  exactly as the skin under it does, and the skin under it is deleted
  afterwards (`cover`), so nothing can poke through it. Its edges are snapped
  onto the planes that cut it -- a hem on a level, a cuff square to the arm --
  because an edge that follows the triangulation of a decimated body is a
  saw-tooth.
* `hanging` -- cloth that hangs off the body rather than wrapping a limb:
  skirts, robes, tabards, aprons, cloaks. Lofted to its own silhouette and
  weighted by formula: the hips at the waist, easing towards the two thighs
  by side lower down but never all the way, so a skirt swings with the
  stride without splitting into trouser legs.
* `rigid` -- plate armour, helmets, hats, a belt buckle: wholly one bone.
* head pieces -- hair, beards, hoods and hats, kept as separate objects so
  the viewer can mix them per person.

Axes as people.py: Z up, the figure faces -Y, its left is +X.
"""

import math
import importlib

import bpy
import bmesh
import mathutils
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

import lib
import people
import rig

V = Vector


# --- reading the body -----------------------------------------------------------

def dominant(obj):
    """The bone with the most weight on each vertex."""
    names = {g.index: g.name for g in obj.vertex_groups}
    out = []
    for v in obj.data.vertices:
        best, bw = None, -1.0
        for g in v.groups:
            if g.weight > bw and names.get(g.group, "").split(".")[0] not in ("HEADISLAND",):
                best, bw = names.get(g.group), g.weight
        out.append(best or "")
    return out


def bone_frac(arm, bone, co):
    """How far along a bone a point lies, 0 at its head and 1 at its tail."""
    b = arm.data.bones[bone]
    h, t = b.head_local, b.tail_local
    d = t - h
    return (co - h).dot(d) / d.length_squared


_DOM = {}


def section(body, z, maxx=0.3, bones=("hips", "spine", "chest", "thigh", "neck")):
    """The body's extent across and front-to-back at a height, counting only
    the trunk and thighs -- the arms hang in the same band and a belt fitted
    round them is a bar through both wrists."""
    key = (body.name, len(body.data.vertices))
    if key not in _DOM:
        _DOM[key] = dominant(body)
    dom = _DOM[key]
    xs, ys = [], []
    for v in body.data.vertices:
        if abs(v.co.z - z) < 0.012 and abs(v.co.x) < maxx and limb(dom[v.index]) in bones:
            xs.append(abs(v.co.x))
            ys.append(v.co.y)
    if not xs:
        return 0.15, -0.1, 0.1
    return max(xs), min(ys), max(ys)


def copy_object(obj, name):
    new = obj.copy()
    new.data = obj.data.copy()
    new.name = name
    new.data.name = name
    bpy.context.collection.objects.link(new)
    return new


# --- shells ---------------------------------------------------------------------

def shell(body, arm, name, keep, offset=0.010, mat="cloth", planes=(), thick=0.006,
          push=None, keep_ratio=0.45):
    """A garment cut from the body where `keep(co, bone)` is true, pushed out
    `offset` along the normals (or by `push(co, bone)` where given), with its
    open edges snapped onto the nearest of `planes` [(point, normal)] and a
    rim of `thick` turned in at every edge so it reads as cloth with a
    thickness rather than a painted surface."""
    obj = copy_object(body, name)
    dom = dominant(body)
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    inside = [keep(v.co.copy(), dom[v.index]) for v in bm.verts]
    dead = [f for f in bm.faces if not all(inside[v.index] for v in f.verts)]
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.normal_update()
    # Snap the open edge onto the cutting planes, then push out.
    # A plane only claims edge vertices near where it cuts: a cuff plane
    # extended to infinity passes through the hem at the waist, and snapped
    # the hem's corners up onto the wrist's.
    planes = [(V(pl[0]), V(pl[1]).normalized(), pl[2] if len(pl) > 2 else 9.0) for pl in planes]
    for v in bm.verts:
        if planes and v.is_boundary:
            near = [pl for pl in planes if (v.co - pl[0]).length < pl[2]]
            if not near:
                continue
            best = min(near, key=lambda pn: abs((v.co - pn[0]).dot(pn[1])))
            d = (v.co - best[0]).dot(best[1])
            if abs(d) < 0.04:
                v.co -= best[1] * d
    normals = {v.index: v.normal.copy() for v in bm.verts}
    for v in bm.verts:
        amt = push(v.co, None) if push else offset
        v.co += normals[v.index] * amt
    bm.to_mesh(me)
    bm.free()
    me.materials.clear()
    me.materials.append(lib.material(mat))
    for p in me.polygons:
        p.use_smooth = True
    if keep_ratio < 1.0:
        # A garment is smoother than the skin it was cut from and needs
        # fewer triangles to say so; the collapse keeps the open edges.
        thin(obj, keep_ratio)
    if thick:
        rim(obj, thick)
    return obj


def thin(obj, ratio):
    mods = [(m.name, m.object) for m in obj.modifiers if m.type == "ARMATURE"]
    for m in list(obj.modifiers):
        obj.modifiers.remove(m)
    dm = obj.modifiers.new("thin", "DECIMATE")
    dm.ratio = ratio
    dm.use_collapse_triangulate = True
    dm.use_symmetry = True
    dm.symmetry_axis = "X"
    people.apply_all(obj)
    for (n, o) in mods:
        a = obj.modifiers.new(n, "ARMATURE")
        a.object = o
    return obj


def rim(obj, thick):
    """Turn every open edge in by `thick`: the band of cloth you see at a hem
    or a cuff. Rim only -- the inside of a garment is never seen, so it is not
    paid for."""
    m = obj.modifiers.new("rim", "SOLIDIFY")
    m.thickness = thick
    m.offset = -1.0
    m.use_rim_only = True
    # Not even-offset: at a sharp corner of a hem that throws a spike.
    m.use_even_offset = False
    # Keep the armature modifier last, so the rim is made at rest and skinned.
    arm_mods = [x for x in obj.modifiers if x.type == "ARMATURE"]
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.modifier_move_to_index(modifier="rim", index=0)
    bpy.ops.object.modifier_apply(modifier="rim")
    return obj


# --- hanging cloth ----------------------------------------------------------------

def skirt_weights(obj, arm, top, hem, follow=0.5, bones=("hips", "skirt.L", "skirt.R"),
                  above=None):
    """Weights for cloth hanging below the waist: all hips at `top`, sliding
    towards the skirt bone on its own side by the time it reaches `hem`.
    `follow` is how much of the thigh's swing the hem takes at a walk; the
    skirt bones already take half of it there (rig.skirt_follow), so a
    follow of 0.5 or more is the whole hem on them. `above` is an optional
    function giving weights for vertices above `top` (a bodice, a tabard's
    chest)."""
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    groups = {b: obj.vertex_groups.new(name=b) for b in bones}
    lower = {b: obj.vertex_groups.new(name=b.replace("skirt.", "skirt2.")) for b in bones[1:]}
    knee = arm.data.bones["shin.L"].head_local.z
    hip = arm.data.bones["thigh.L"].head_local
    for v in obj.data.vertices:
        z = v.co.z
        if above and z > top:
            for b, w in above(v.co).items():
                if b not in groups:
                    groups[b] = obj.vertex_groups.new(name=b)
                groups[b].add([v.index], w, "REPLACE")
            continue
        # Over to the skirt bones by a hand's breadth below the hip joint.
        # Blended with the hips any lower, a seated body pulled the cloth
        # over its thighs half-way to where the thighs went: into the seat
        # behind, and stretched to nothing over the lap.
        t = max(0.0, min(1.0, (top - z) / max(0.08, top - (hip.z - 0.12))))
        t = t * t * (3 - 2 * t) * min(1.0, follow / 0.5)
        side = max(0.0, min(1.0, 0.5 + v.co.x / 0.12))
        # Below the knee the shin's twin carries it.
        u = max(0.0, min(1.0, (knee + 0.06 - z) / 0.12))
        u = u * u * (3 - 2 * u)
        groups["hips"].add([v.index], 1.0 - t, "REPLACE")
        for b, s_ in ((bones[1], side), (bones[2], 1.0 - side)):
            groups[b].add([v.index], t * s_ * (1.0 - u), "REPLACE")
            lower[b].add([v.index], t * s_ * u, "REPLACE")
    return obj


def transfer_weights(obj, body, only=None):
    """Weights off the nearest body vertex, for a piece that sits on the body
    but was not cut from it. `only` restricts which body vertices count."""
    dom = dominant(body)
    kd = KDTree(len(body.data.vertices))
    n = 0
    for v in body.data.vertices:
        if only is None or only(v.co, dom[v.index]):
            kd.insert(v.co, v.index)
            n += 1
    kd.balance()
    names = {g.index: g.name for g in body.vertex_groups}
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    groups = {}
    for v in obj.data.vertices:
        co, idx, dist = kd.find(v.co)
        for g in body.data.vertices[idx].groups:
            name = names[g.group]
            if name == "HEADISLAND" or g.weight < 1e-3:
                continue
            if name not in groups:
                groups[name] = obj.vertex_groups.new(name=name)
            groups[name].add([v.index], g.weight, "REPLACE")
    return obj


def loft_skirt(body, name, top, hem, flare=1.35, mat="cloth", sides=24, rings=8,
               ease=0.014, hem_wave=0.0, ragged=0.0, lift_front=0.0, under=(), smooth=True):
    """A skirt, or the lower half of a tunic or robe: rings from `top` down to
    `hem`. Each ring is fitted to whatever it covers -- found by casting rays
    in at it from outside, since a trunk is not an ellipse and an ellipse
    fitted to its width leaves the buttocks and the belly poking through --
    then hangs straight from the widest point above it and flares by `flare`
    at the hem. `hem_wave` pleats it into folds, `ragged` tears the hem."""
    tree = bvh([body] + list(under))
    x0, y0, y1 = section(body, top)
    cy = (y0 + y1) / 2
    verts, faces = [], []
    reach = [0.0] * sides
    for ri in range(rings + 1):
        t = ri / rings
        z = top + (hem - top) * t
        k = 1.0 + (flare - 1.0) * (t ** 1.3)
        for i in range(sides):
            a = 2 * math.pi * i / sides
            d = V((math.cos(a), -math.sin(a), 0.0))
            origin = V((0.0, cy, z)) + d * 0.6
            loc, _, _, _ = tree.ray_cast(origin, -d, 0.6)
            r = ((loc - V((0.0, cy, z))).xy.length if loc is not None else 0.0) + ease
            reach[i] = max(reach[i], r)
            rr = reach[i] * k
            # Folds that fall from the waist and deepen to the hem, not a
            # fluted column: two sets out of step, so no two are alike.
            fold = 1.0 + hem_wave * t * t * (0.65 * math.sin(a * 7 + 0.7) + 0.35 * math.sin(a * 13 + 2.1))
            zz = z
            if ri == rings:
                zz += ragged * (0.5 + 0.5 * math.sin(a * 13.0) * math.sin(a * 5.0 + 1.0))
                zz += lift_front * max(0.0, -d.y)
            verts.append((d.x * rr * fold, cy + d.y * rr * fold, zz))
        # Neighbouring columns are eased together, so a single ray that
        # slipped between the legs does not notch the hem.
        if ri > 0 and smooth:
            base = ri * sides
            sm = [(verts[base + (i - 1) % sides], verts[base + i], verts[base + (i + 1) % sides])
                  for i in range(sides)]
            for i, (pa, pb, pc) in enumerate(sm):
                verts[base + i] = tuple((V(pa) + V(pb) * 2 + V(pc)) / 4)
    for k in range(rings):
        b = k * sides
        for i in range(sides):
            j = (i + 1) % sides
            faces.append((b + i, b + j, b + j + sides, b + i + sides))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, mat)
    people.outward(obj)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def panel(name, pts_top, pts_bottom, rows=8, mat="cloth", curve_y=None):
    """A hanging panel -- a tabard's front, an apron -- between two polylines
    of the same length, top and bottom, subdivided in `rows`."""
    cols = len(pts_top)
    verts, faces = [], []
    for r in range(rows + 1):
        t = r / rows
        for c in range(cols):
            a, b = V(pts_top[c]), V(pts_bottom[c])
            p = a + (b - a) * t
            if curve_y:
                p.y += curve_y(p, t)
            verts.append(tuple(p))
    for r in range(rows):
        for c in range(cols - 1):
            i = r * cols + c
            faces.append((i, i + 1, i + 1 + cols, i + cols))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, mat)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def thicken(obj, t=0.006):
    m = obj.modifiers.new("thick", "SOLIDIFY")
    m.thickness = t
    m.offset = 0.0
    people.apply_all(obj)
    return obj


# --- rigid pieces -------------------------------------------------------------------

def rigid_shell(body, arm, name, keep, bone, offset=0.02, mat="steel", planes=(), thick=0.008,
                keep_ratio=0.45):
    obj = shell(body, arm, name, keep, offset=offset, mat=mat, planes=planes, thick=thick,
                keep_ratio=keep_ratio)
    rig.set_rigid(obj, bone)
    return obj


def ring(name, center, r, tube, mat="leather", seg=24, rot=(0, 0, 0), scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_torus_add(major_radius=r, minor_radius=tube, major_segments=seg,
                                     minor_segments=4, location=center, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    lib.assign(o, mat)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def belt(body, z, name="belt", mat="leather", width=0.045, ease=0.008, buckle="iron",
         under=(), sides=20):
    """A belt at `z`, drawn tight round whatever it is buckled over."""
    tree = bvh([body] + list(under))
    x0, y0, y1 = section(body, z)
    cy = (y0 + y1) / 2
    verts, faces = [], []
    radii = []
    for i in range(sides):
        a = 2 * math.pi * i / sides
        d = V((math.cos(a), -math.sin(a), 0.0))
        best = 0.0
        for dz in (-width / 2, 0.0, width / 2):
            o = V((0.0, cy, z + dz))
            loc, _, _, _ = tree.ray_cast(o + d * 0.6, -d, 0.6)
            if loc is not None:
                best = max(best, (loc - o).xy.length)
        radii.append(best + ease)
    radii = [(radii[i - 1] + 2 * radii[i] + radii[(i + 1) % sides]) / 4 for i in range(sides)]
    for (k, dz, bulge) in ((0, -width / 2, 0.0), (1, 0.0, 0.003), (2, width / 2, 0.0)):
        for i in range(sides):
            a = 2 * math.pi * i / sides
            d = V((math.cos(a), -math.sin(a), 0.0))
            p = V((0.0, cy, z + dz)) + d * (radii[i] + bulge)
            verts.append(tuple(p))
    for k in range(2):
        for i in range(sides):
            j = (i + 1) % sides
            faces.append((k * sides + i, k * sides + j, (k + 1) * sides + j, (k + 1) * sides + i))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    b = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(b)
    lib.assign(b, mat)
    people.outward(b)
    thicken(b, 0.006)
    for p in b.data.polygons:
        p.use_smooth = True
    parts = [b]
    if buckle:
        front = radii[sides // 4]
        parts.append(lib.box((0.052, 0.012, width * 1.15), (0, cy - front - 0.006, z),
                             name="buckle", mat=buckle))
    return parts


# --- covering -----------------------------------------------------------------------

def cover(body, garments, reach=0.045, keep=None, deep=()):
    """Delete the skin nothing can see: every body face whose vertices all
    have a garment within `reach` along their outward normal. `keep(co)`
    protects regions that must stay whatever covers them."""
    deps = bpy.context.evaluated_depsgraph_get()
    trees = []
    for g in garments:
        bm = bmesh.new()
        bm.from_mesh(g.data)
        trees.append(BVHTree.FromBMesh(bm))
        bm.free()
    # A long skirt stands well off the legs it hides, further than `reach`,
    # and a leg left under one comes through the front of it the moment it
    # strides. So under a skirt the rays go further -- but not below 12 cm,
    # where the feet show under the hem.
    deep_trees = []
    for g in deep:
        bm = bmesh.new()
        bm.from_mesh(g.data)
        top = max(v.co.z for v in bm.verts)
        deep_trees.append((BVHTree.FromBMesh(bm), top))
        bm.free()
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.normal_update()
    hidden = set()
    for v in bm.verts:
        if keep and keep(v.co):
            continue
        n = v.normal
        hit = False
        for tr in trees:
            loc, nrm, idx, d = tr.ray_cast(v.co + n * 0.001, n, reach)
            if loc is not None:
                hit = True
                break
        if not hit and 0.12 < v.co.z:
            for tr, top in deep_trees:
                if v.co.z < top - 0.02:
                    loc, _, _, _ = tr.ray_cast(v.co + n * 0.001, n, 0.40)
                    if loc is not None:
                        hit = True
                        break
        if hit:
            hidden.add(v.index)
    dead = [f for f in bm.faces if all(v.index in hidden for v in f.verts)]
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(body.data)
    bm.free()
    return body


# --- cuts -----------------------------------------------------------------------------

class Cuts:
    """Landmarks on one rig, and the planes a tailor would cut along."""

    def __init__(self, arm, P):
        self.arm, self.P = arm, P
        b = arm.data.bones
        self.b = b
        self.neck = P["neck_base"]
        self.hipz = P["hip"][2]
        self.k = (P["shoulder"][2] - P["hip"][2]) / (1.445 - 0.955)
        self.kl = P["hip"][2] / 0.955

    def z(self, m):
        """A man's torso height, on this body."""
        return self.hipz + (m - 0.955) * self.k

    def zl(self, m):
        """A man's leg height, on this body."""
        return m * self.kl

    def along(self, bone, frac, reach=0.10):
        """(point, normal, reach) of the plane square to a bone at `frac` of
        its length; the normal points back towards the bone's head."""
        bb = self.b[bone]
        h, t = bb.head_local, bb.tail_local
        return (h + (t - h) * frac, -(t - h).normalized(), reach)

    def frac(self, bone, co):
        return bone_frac(self.arm, bone, co)

    def neckline(self, drop=0.03, back=0.0):
        """A neckline: lower at the front by `drop`."""
        p = V((0.0, 0.0, self.neck - 0.005 - back))
        n = V((0.0, drop * 6.0, -1.0)).normalized()
        return (p, n, 0.16)


def above(plane, co):
    return (co - plane[0]).dot(plane[1]) >= 0.0


def limb(bone):
    return bone.split(".")[0] if bone else ""


def side(bone):
    return bone.split(".")[1] if bone and "." in bone else ""


# --- garments, by kind ----------------------------------------------------------------

def tunic_body(body, arm, C, sleeve=0.45, hem=None, neck_drop=0.03, mat="cloth",
               offset=0.010, name="tunic"):
    """The upper half of a tunic, shirt, gambeson or mail: torso and sleeves.
    `sleeve` is how far down the forearm the sleeve reaches (0 = to the elbow,
    negative = short sleeves up the upper arm)."""
    hem = hem if hem is not None else C.z(0.90)
    neck = C.neckline(neck_drop)
    cuffs = {}
    for t in "LR":
        if sleeve >= 0:
            cuffs[t] = ("forearm." + t, C.along("forearm." + t, sleeve))
        else:
            cuffs[t] = ("upperarm." + t, C.along("upperarm." + t, 1.0 + sleeve))

    def keep(co, bone):
        # The neckline only cuts near the neck; the tops of the shoulders
        # stand higher than it and are cloth.
        if (abs(co.x) < 0.10 and not above(neck, co)) or co.z < hem - 0.001:
            return False
        l = limb(bone)
        if l in ("head", "neck"):
            return above(neck, co) and co.z < C.neck
        if l in ("hand", "thigh", "shin", "foot", "toe"):
            return l == "thigh" and co.z >= hem
        if l in ("upperarm", "forearm"):
            b, pl = cuffs[side(bone)]
            if limb(b) == "upperarm" and l == "forearm":
                return False
            return above(pl, co)
        return True
    planes = [neck, (V((0, 0, hem)), V((0, 0, 1)))] + [pl for (_, pl) in cuffs.values()]
    return shell(body, arm, name, keep, offset=offset, mat=mat, planes=planes)


def hose(body, arm, C, top=None, ankle=0.97, mat="cloth2", offset=0.007, name="hose"):
    """Legs and seat, from `top` down to `ankle` of the shin."""
    top = top if top is not None else C.z(1.00)
    cuffs = {t: C.along("shin." + t, ankle) for t in "LR"}

    def keep(co, bone):
        l = limb(bone)
        if co.z > top:
            return False
        if l in ("hips", "spine", "thigh"):
            return True
        if l == "shin":
            return above(cuffs[side(bone)], co)
        return False
    planes = [(V((0, 0, top)), V((0, 0, -1)))] + list(cuffs.values())
    return shell(body, arm, name, keep, offset=offset, mat=mat, planes=planes)


def boots(body, arm, C, top=0.55, mat="leather", offset=0.011, name="boots"):
    """Boots to `top` of the shin (from the knee), over the whole foot."""
    cuffs = {t: C.along("shin." + t, top) for t in "LR"}
    for t in "LR":
        p, n, r = cuffs[t]
        cuffs[t] = (p, -n, r)

    def keep(co, bone):
        l = limb(bone)
        if l in ("foot", "toe"):
            return True
        if l == "shin":
            return above(cuffs[side(bone)], co)
        return False

    def push(co, _):
        # Sole stays near the ground; the upper stands off the leg.
        return offset if co.z > 0.03 else 0.004
    return shell(body, arm, name, keep, offset=offset, mat=mat, planes=list(cuffs.values()),
                 thick=0.008, push=push)


def gloves(body, arm, C, cuff=0.75, mat="leather", offset=0.004, name="gloves"):
    cuffs = {t: C.along("forearm." + t, cuff) for t in "LR"}
    for t in "LR":
        p, n, r = cuffs[t]
        cuffs[t] = (p, -n, r)

    def keep(co, bone):
        l = limb(bone)
        if l == "hand":
            return True
        if l == "forearm":
            return above(cuffs[side(bone)], co)
        return False
    return shell(body, arm, name, keep, offset=offset, mat=mat, planes=list(cuffs.values()),
                 thick=0.005)


ARMS = ("upperarm", "forearm", "hand", "shoulder")


def bvh(objs, trunk_only=True):
    """One ray-castable tree over several meshes, at rest. The arms are left
    out of it: they hang beside the hips, and a skirt fitted to them stands
    out like a lampshade."""
    bm = bmesh.new()
    for o in objs:
        tmp = bmesh.new()
        tmp.from_mesh(o.data)
        if trunk_only and o.vertex_groups:
            dom = dominant(o)
            tmp.verts.ensure_lookup_table()
            dead = [f for f in tmp.faces
                    if any(limb(dom[v.index]) in ARMS for v in f.verts)]
            bmesh.ops.delete(tmp, geom=dead, context="FACES")
        tmp.transform(o.matrix_world)
        me = bpy.data.meshes.new("_tmp")
        tmp.to_mesh(me)
        tmp.free()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree


def drape(tree, x, z, sgn, fallback):
    """How far out the surface under a hanging panel is at (x, z): a ray in
    from the front (sgn -1) or the back (+1)."""
    loc, _, _, _ = tree.ray_cast(V((x, sgn * 0.6, z)), V((0.0, -sgn, 0.0)), 0.6)
    return loc.y if loc is not None else fallback


def tabard(body, arm, C, hem, width=0.17, mat="cloth", name="tabard", gap=0.016, under=(),
           belt_z=None):
    """A tabard or surcoat: a panel down the front and one down the back,
    hanging from the shoulders, open at the sides. It lies on whatever it is
    worn over down to the belt -- found by casting rays at it, because a panel
    placed by a formula went under the mail at the chest -- and hangs
    straight from the belt, weighted as a skirt."""
    tree = bvh([body] + list(under))
    belt_z = belt_z if belt_z is not None else C.z(1.03)
    pieces = []
    for (sgn, tag) in ((-1, "front"), (1, "back")):
        cols = 6
        rows = 11
        verts, faces = [], []
        top = C.neck - 0.022
        # Each row is one stiff curve: as far out as the front-most thing
        # under it, falling back a little towards the edges. Following every
        # ray column by column dented it into the gaps and ballooned it over
        # the chest, and cloth that heavy does neither.
        hung = None
        for r in range(rows + 1):
            t = r / rows
            z = top + (hem - top) * t
            w = width * (0.60 + 0.40 * min(1.0, t * 3.5))
            zz = max(z, belt_z) if z > belt_z - 0.001 else z
            hits = [drape(tree, u * w * 0.9, zz, sgn, None) for u in (-1, -0.5, 0, 0.5, 1)]
            hits = [h for h in hits if h is not None]
            front = (min(hits) if sgn < 0 else max(hits)) if hits else sgn * 0.13
            if z < belt_z:
                if hung is None:
                    hung = front
                front = min(front, hung) if sgn < 0 else max(front, hung)
                front += sgn * 0.015 * ((belt_z - z) / max(1e-3, belt_z - hem)) ** 1.5
            for c in range(cols + 1):
                u = -1.0 + 2.0 * c / cols
                y = front + sgn * gap - sgn * 0.018 * u * u
                verts.append((u * w, y, z))
        for r in range(rows):
            for c in range(cols):
                i = r * (cols + 1) + c
                faces.append((i, i + 1, i + 2 + cols, i + 1 + cols) if sgn < 0 else
                             (i, i + 1 + cols, i + 2 + cols, i + 1))
        mesh = bpy.data.meshes.new(name + tag)
        mesh.from_pydata(verts, [], faces)
        mesh.validate()
        obj = bpy.data.objects.new(name + "_" + tag, mesh)
        bpy.context.collection.objects.link(obj)
        lib.assign(obj, mat)
        people.outward(obj)
        for p in obj.data.polygons:
            p.use_smooth = True
        thicken(obj, 0.006)
        hang(obj, arm, body, C, belt_z - 0.02, hem, follow=0.45)
        pieces.append(obj)
    return pieces


def transfer_weights_fn(body, only):
    """A function co -> {bone: weight} off the nearest body vertex."""
    dom = dominant(body)
    kd = KDTree(len(body.data.vertices))
    for v in body.data.vertices:
        if only(v.co, dom[v.index]):
            kd.insert(v.co, v.index)
    kd.balance()
    names = {g.index: g.name for g in body.vertex_groups}

    def fn(co):
        _, idx, _ = kd.find(co)
        return {names[g.group]: g.weight for g in body.data.vertices[idx].groups
                if g.weight > 1e-3 and names[g.group] != "HEADISLAND"}
    return fn


def hang(obj, arm, body, C, top, hem, follow=0.5):
    """Weight a hanging piece: skirt weights below `top`, body weights above."""
    chest = transfer_weights_fn(body, lambda co, b: limb(b) in ("chest", "spine", "hips", "shoulder", "neck"))
    skirt_weights(obj, arm, top, hem, follow=follow, above=chest)
    return obj


# --- the archetypes -------------------------------------------------------------------

def peasant(body, arm, C):
    """A labourer: a short belted tunic over hose, and boots."""
    top = tunic_body(body, arm, C, sleeve=0.55, hem=C.z(0.93))
    skirt = loft_skirt(body, "tunic_skirt", C.z(1.00), C.zl(0.70), flare=1.12, mat="cloth",
                       hem_wave=0.06, under=[top])
    hang(skirt, arm, body, C, C.z(0.99), C.zl(0.70), follow=0.55)
    rim(skirt, 0.006)
    legs = hose(body, arm, C)
    feet = boots(body, arm, C, top=0.62)
    bt = belt(body, C.z(1.03), under=[top, skirt])
    for b in bt:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    return [top, skirt, legs, feet] + bt


def guard(body, arm, C):
    """The watch: a mail shirt to mid-thigh over a padded coat, a tabard in
    the town's colour on top of it, hose and boots, a belt."""
    mail = tunic_body(body, arm, C, sleeve=0.2, hem=C.z(0.93), mat="mail", offset=0.013,
                      neck_drop=0.012, name="mail")
    skirt = loft_skirt(body, "mail_skirt", C.z(1.00), C.zl(0.66), flare=1.10, mat="mail",
                       under=[mail])
    hang(skirt, arm, body, C, C.z(0.99), C.zl(0.66), follow=0.6)
    rim(skirt, 0.006)
    tb = tabard(body, arm, C, C.zl(0.60), width=0.165, mat="cloth", under=[mail, skirt])
    legs = hose(body, arm, C)
    feet = boots(body, arm, C, top=0.45)
    bt = belt(body, C.z(1.03), under=[mail, skirt] + tb)
    for b in bt:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    return [mail, skirt, legs, feet] + tb + bt


def apron(body, arm, C, top, hem, width=0.15, mat="linen", under=(), bib=False, name="apron"):
    """An apron: a panel down the front from the waist (or from the chest,
    with a bib) to `hem`, over whatever is worn beneath, tied at the waist."""
    tree = bvh([body] + list(under))
    cols, rows = 7, 12
    verts, faces = [], []
    belt_z = C.z(1.05)
    start = top
    hung = None
    for r in range(rows + 1):
        t = r / rows
        z = start + (hem - start) * t
        w = width * (0.72 if (bib and z > belt_z) else 1.0) + (0.02 * t if z < belt_z else 0.0)
        hits = [drape(tree, u * w * 0.9, max(z, belt_z) if z > belt_z else z, -1, None)
                for u in (-1, -0.5, 0, 0.5, 1)]
        hits = [h for h in hits if h is not None]
        front = min(hits) if hits else -0.13
        if z < belt_z:
            if hung is None:
                hung = front
            front = min(front, hung) - 0.01 * ((belt_z - z) / max(1e-3, belt_z - hem))
        for c in range(cols + 1):
            u = -1.0 + 2.0 * c / cols
            verts.append((u * w, front - 0.012 + 0.02 * u * u, z))
    for r in range(rows):
        for c in range(cols):
            i = r * (cols + 1) + c
            faces.append((i, i + 1, i + 2 + cols, i + 1 + cols))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, mat)
    people.outward(obj)
    for p in obj.data.polygons:
        p.use_smooth = True
    thicken(obj, 0.005)
    hang(obj, arm, body, C, belt_z - 0.02, hem, follow=0.4)
    return obj


def cloak(body, arm, C, hem, mat="cloth", under=(), width=0.26, name="cloak", ragged=0.0,
          arc=(15, 165)):
    """A cloak hanging from the shoulders down the back, wrapping round the
    sides: rows fitted over the shoulders and falling straight from the
    widest point, flaring a little to the hem."""
    tree = bvh([body] + list(under))
    cols, rows = 12, 14
    top = C.neck - 0.01
    verts, faces = [], []
    reach = [None] * (cols + 1)
    for r in range(rows + 1):
        t = r / rows
        z = top + (hem - top) * t
        for c in range(cols + 1):
            # Round the back from one shoulder to the other: angle 20..160
            # degrees measured from the figure's left.
            a = math.radians(arc[0] + (arc[1] - arc[0]) * c / cols)
            d = V((math.cos(a), math.sin(a), 0.0))
            o = V((0.0, 0.0, max(z, C.z(1.30)) if t < 0.15 else z))
            loc, _, _, _ = tree.ray_cast(o + d * 0.7, -d, 0.7)
            rr = ((loc - o).xy.length if loc is not None else 0.16) + 0.018
            if z > C.z(1.38):
                # Over the shoulders it narrows up to the neck.
                k = (z - C.z(1.38)) / max(1e-3, top - C.z(1.38))
                rr = rr * (1 - 0.45 * k)
            if reach[c] is None or z > C.z(1.38):
                reach[c] = rr
            reach[c] = max(reach[c], rr)
            rr = reach[c] * (1.0 + 0.18 * t * t)
            zz = z + (ragged * math.sin(c * 2.7) * math.sin(c * 1.3) if r == rows else 0.0)
            verts.append((d.x * rr, d.y * rr, zz))
    for r in range(rows):
        for c in range(cols):
            i = r * (cols + 1) + c
            faces.append((i, i + 1 + cols, i + 2 + cols, i + 1))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, mat)
    people.outward(obj)
    for p in obj.data.polygons:
        p.use_smooth = True
    thicken(obj, 0.006)
    hang(obj, arm, body, C, C.z(1.10), hem, follow=0.3)
    return obj


def cowl(body, arm, C, mat="cloth", name="cowl", depth=0.05):
    """A hood worn down: a thick roll of cloth round the neck and over the
    tops of the shoulders."""
    z0 = C.neck - 0.015
    x0, y0, y1 = section(body, z0 - 0.03, bones=("chest", "neck", "spine"))
    cy = (y0 + y1) / 2
    rings = [(-0.035, x0 * 0.95 + 0.02, cy - y0 + 0.02, y1 - cy + 0.03, 0, 0, 2.2),
             (0.0, x0 * 0.80 + 0.03, cy - y0 + 0.028, y1 - cy + depth, 0, 0, 2.0),
             (0.035, x0 * 0.55 + 0.02, cy - y0 + 0.012, y1 - cy + depth * 0.7, 0, 0, 2.0),
             (0.055, x0 * 0.45, cy - y0 - 0.005, y1 - cy + 0.01, 0, 0, 2.0)]
    o = people.ring_loft((0, cy, z0), (0, 0, 1), rings, sides=24, side=(-1, 0, 0), name=name, mat=mat)
    for p in o.data.polygons:
        p.use_smooth = True
    transfer_weights(o, body, lambda co, b: limb(b) in ("chest", "neck", "shoulder"))
    return o


def robe(body, arm, C, mat="cloth", hem=0.06, flare=1.45, sleeve=0.92, name="robe", wide=False):
    """A robe: a long-sleeved body to the hips and a skirt to the ankles."""
    top = tunic_body(body, arm, C, sleeve=sleeve, hem=C.z(0.93), mat=mat, offset=0.012,
                     neck_drop=0.02, name=name)
    skirt = loft_skirt(body, name + "_skirt", C.z(1.00), C.zl(hem), flare=flare, mat=mat,
                       hem_wave=0.08, under=[top], rings=14)
    hang(skirt, arm, body, C, C.z(1.00), C.zl(hem), follow=0.42)
    rim(skirt, 0.006)
    out = [top, skirt]
    if wide:
        # Bell sleeves: a flared cuff hanging from mid-forearm.
        for t in "LR":
            p, n, _ = C.along("forearm." + t, 0.35)
            d = -n
            cuff = people.ring_loft(p, d, [(0.0, 0.052, 0.052, 0.052), (0.10, 0.068, 0.07, 0.066),
                                           (0.17, 0.085, 0.09, 0.08)],
                                    sides=16, name="sleeve_" + t, mat=mat, caps=False)
            people.outward(cuff)
            for q in cuff.data.polygons:
                q.use_smooth = True
            thicken(cuff, 0.005)
            rig.set_rigid(cuff, "forearm." + t)
            out.append(cuff)
    return out


def merchant(body, arm, C):
    """A shopkeeper: a knee-length tunic, hose, shoes, and an apron over it."""
    top = tunic_body(body, arm, C, sleeve=0.7, hem=C.z(0.93))
    skirt = loft_skirt(body, "tunic_skirt", C.z(1.00), C.zl(0.50), flare=1.16, mat="cloth",
                       hem_wave=0.06, under=[top], rings=12)
    hang(skirt, arm, body, C, C.z(1.00), C.zl(0.50), follow=0.5)
    rim(skirt, 0.006)
    legs = hose(body, arm, C)
    feet = boots(body, arm, C, top=0.88)
    ap = apron(body, arm, C, C.z(1.30), C.zl(0.42), width=0.16, mat="linen", under=[top, skirt],
               bib=True)
    bt = belt(body, C.z(1.05), under=[top, skirt, ap], width=0.03, buckle=None, mat="linen")
    for b in bt:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    return [top, skirt, legs, feet, ap] + bt


def smith(body, arm, C):
    """A smith: sleeves short and the forearms bare, a heavy leather apron
    from the chest to the shin."""
    top = tunic_body(body, arm, C, sleeve=-0.55, hem=C.z(0.93), mat="cloth")
    skirt = loft_skirt(body, "tunic_skirt", C.z(1.00), C.zl(0.72), flare=1.1, mat="cloth",
                       under=[top])
    hang(skirt, arm, body, C, C.z(1.00), C.zl(0.72), follow=0.55)
    rim(skirt, 0.006)
    legs = hose(body, arm, C)
    feet = boots(body, arm, C, top=0.6)
    ap = apron(body, arm, C, C.z(1.36), C.zl(0.34), width=0.17, mat="leather",
               under=[top, skirt], bib=True)
    bt = belt(body, C.z(1.05), under=[top, skirt, ap], width=0.03)
    for b in bt:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    return [top, skirt, legs, feet, ap] + bt


def holy_symbol(body, arm, C, under=()):
    """A cleric's holy symbol: a gilt disc with a sunburst cross, on a cord
    round the neck, lying on the breastbone. It is the one thing that tells a
    priest from a monk from a hermit at street distance, so it is overscaled
    and bright."""
    tree = bvh([body] + list(under))
    z = C.z(1.30)
    y = drape(tree, 0.0, z, -1, -0.12) - 0.008
    disc = people.ring_loft(V((0.0, y + 0.004, z)), (0, -1, 0), [
        (0.0, 0.036, 0.036, 0.036), (0.006, 0.038, 0.038, 0.038), (0.008, 0.030, 0.030, 0.030)],
        sides=16, side=(1, 0, 0), name="symbol", mat="gold")
    bar_v = lib.box((0.012, 0.008, 0.062), (0.0, y - 0.006, z), name="symbol_v", mat="gold")
    bar_h = lib.box((0.050, 0.008, 0.012), (0.0, y - 0.006, z + 0.008), name="symbol_h", mat="gold")
    # The cord: from the disc up over the collar on either side.
    cord = []
    for sx in (-1, 1):
        a = V((sx * 0.012, y + 0.002, z + 0.034))
        b = V((sx * 0.060, drape(tree, sx * 0.06, C.neck - 0.02, -1, y) + 0.004, C.neck - 0.012))
        cord.append(people.ring_loft(a, b - a, [(0.0, 0.0022, 0.0022, 0.0022),
                                                ((b - a).length, 0.0022, 0.0022, 0.0022)],
                                     sides=4, name="cord", mat="leather"))
    parts = [disc, bar_v, bar_h] + cord
    for o in parts:
        rig.set_rigid(o, "chest")
    return parts


def priest(body, arm, C):
    """A cleric: an ankle-length robe with a hood worn down, a cord, and the
    holy symbol on his breast."""
    parts = robe(body, arm, C, mat="cloth", hem=0.05, flare=1.35, sleeve=0.9, wide=True)
    feet = boots(body, arm, C, top=0.92)
    cw = cowl(body, arm, C, mat="cloth")
    bt = belt(body, C.z(1.06), under=parts, width=0.016, buckle=None, mat="linen")
    for b in bt:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    sym = holy_symbol(body, arm, C, under=parts + [cw])
    return parts + [feet, cw] + bt + sym


def mage(body, arm, C):
    """A mage: the robe, wide-sleeved and trimmed, and a sash."""
    parts = robe(body, arm, C, mat="cloth", hem=0.03, flare=1.5, sleeve=0.9, wide=True)
    feet = boots(body, arm, C, top=0.92)
    bt = belt(body, C.z(1.06), under=parts, width=0.05, buckle="iron", mat="cloth2")
    for b in bt:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    return parts + [feet] + bt


def rogue(body, arm, C):
    """A thief: dark close tunic and hose, tall boots, and a cloak to the
    knee that the hood (a head piece) goes with."""
    top = tunic_body(body, arm, C, sleeve=0.92, hem=C.z(0.93), mat="cloth2")
    skirt = loft_skirt(body, "tunic_skirt", C.z(1.00), C.zl(0.72), flare=1.08, mat="cloth2",
                       under=[top])
    hang(skirt, arm, body, C, C.z(1.00), C.zl(0.72), follow=0.55)
    rim(skirt, 0.006)
    legs = hose(body, arm, C, mat="leather")
    feet = boots(body, arm, C, top=0.25)
    bt = belt(body, C.z(1.03), under=[top, skirt])
    for b in bt:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    ck = cloak(body, arm, C, C.zl(0.45), mat="wool", under=[top, skirt] + bt)
    return [top, skirt, legs, feet, ck] + bt


def beggar(body, arm, C):
    """Rags: a torn tunic, torn hose ending mid-calf, and bare feet."""
    top = tunic_body(body, arm, C, sleeve=0.3, hem=C.z(0.93), neck_drop=0.05)
    skirt = loft_skirt(body, "tunic_skirt", C.z(1.00), C.zl(0.62), flare=1.18, mat="cloth",
                       hem_wave=0.07, ragged=0.07, under=[top], rings=10)
    hang(skirt, arm, body, C, C.z(1.00), C.zl(0.62), follow=0.55)
    rim(skirt, 0.005)
    legs = hose(body, arm, C, ankle=0.55)
    rope = belt(body, C.z(1.02), under=[top, skirt], width=0.014, buckle=None, mat="linen")
    for b in rope:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    return [top, skirt, legs] + rope


def noble(body, arm, C):
    """A burgher or a lord: a long gown to below the knee, a short cape, a
    good belt and boots."""
    top = tunic_body(body, arm, C, sleeve=0.9, hem=C.z(0.93), mat="cloth")
    skirt = loft_skirt(body, "gown_skirt", C.z(1.00), C.zl(0.34), flare=1.25, mat="cloth",
                       hem_wave=0.06, under=[top], rings=12)
    hang(skirt, arm, body, C, C.z(1.00), C.zl(0.34), follow=0.5)
    rim(skirt, 0.006)
    legs = hose(body, arm, C)
    feet = boots(body, arm, C, top=0.5)
    bt = belt(body, C.z(1.04), under=[top, skirt], buckle="iron")
    for b in bt:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    cape = cloak(body, arm, C, C.z(1.02), mat="wool", under=[top] + bt, name="cape")
    return [top, skirt, legs, feet, cape] + bt


def knight(body, arm, C):
    """A knight: mail to the wrist and the knee, a surcoat over it, plate at
    the shoulders, forearms and shins, steel gauntlets and sabatons."""
    mail = tunic_body(body, arm, C, sleeve=0.92, hem=C.z(0.93), mat="mail", offset=0.013,
                      neck_drop=0.01, name="mail")
    skirt = loft_skirt(body, "mail_skirt", C.z(1.00), C.zl(0.52), flare=1.12, mat="mail",
                       under=[mail])
    hang(skirt, arm, body, C, C.z(1.00), C.zl(0.52), follow=0.6)
    rim(skirt, 0.006)
    legs = hose(body, arm, C, mat="mail", offset=0.009)
    coat = tabard(body, arm, C, C.zl(0.40), width=0.19, mat="cloth", under=[mail, skirt])
    plates = []
    for t in "LR":
        # Pauldron: a cap over the point of the shoulder.
        def keep_p(co, bone, t=t):
            return limb(bone) in ("shoulder", "upperarm") and side(bone) == t and \
                C.frac("upperarm." + t, co) < 0.38 and co.z > C.z(1.30)
        plates.append(rigid_shell(body, arm, "pauldron_" + t, keep_p, "upperarm." + t, offset=0.032,
                                  mat="steel", planes=[C.along("upperarm." + t, 0.38)]))

        def keep_v(co, bone, t=t):
            return bone == "forearm." + t and 0.15 < C.frac("forearm." + t, co) < 0.85
        plates.append(rigid_shell(body, arm, "vambrace_" + t, keep_v, "forearm." + t, offset=0.024,
                                  mat="steel"))

        def keep_g(co, bone, t=t):
            return bone == "shin." + t and 0.05 < C.frac("shin." + t, co) < 0.72
        plates.append(rigid_shell(body, arm, "greave_" + t, keep_g, "shin." + t, offset=0.022,
                                  mat="steel"))
    hands = gloves(body, arm, C, mat="steel", offset=0.007, cuff=0.7)
    feet = boots(body, arm, C, top=0.7, mat="steel", offset=0.014)
    bt = belt(body, C.z(1.03), under=[mail, skirt] + coat)
    for b in bt:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    return [mail, skirt, legs, hands, feet] + coat + plates + bt


def zombie(body, arm, C):
    """What is left of a peasant's clothes on something that has been in the
    ground: the tunic torn short at the hem and the sleeves, hose in tatters."""
    top = tunic_body(body, arm, C, sleeve=-0.35, hem=C.z(0.93), neck_drop=0.07)
    skirt = loft_skirt(body, "tunic_skirt", C.z(1.00), C.zl(0.70), flare=1.1, mat="cloth",
                       hem_wave=0.08, ragged=0.09, under=[top], rings=8)
    hang(skirt, arm, body, C, C.z(1.00), C.zl(0.70), follow=0.55)
    rim(skirt, 0.005)
    legs = hose(body, arm, C, ankle=0.4)
    return [top, skirt, legs]


def ghost(body, arm, C):
    """A shade: a shroud to the ground, hooded (the hood is a head piece)."""
    parts = robe(body, arm, C, mat="cloth", hem=0.0, flare=1.6, sleeve=0.95, wide=True,
                 name="shroud")
    return parts


def woman(body, arm, C, hem=0.03, ragged=0.0, apron_on=False, shawl=False):
    """A woman of the town: a fitted bodice with long sleeves, a full skirt to
    the ankle gathered at the waist, a sash, and shoes."""
    top = tunic_body(body, arm, C, sleeve=0.8, hem=C.z(0.99), neck_drop=0.05, mat="cloth")
    skirt = loft_skirt(body, "skirt", C.z(1.06), C.zl(hem), flare=1.55, mat="cloth",
                       hem_wave=0.08, ragged=ragged, under=[top], rings=10)
    hang(skirt, arm, body, C, C.z(1.06), C.zl(hem), follow=0.4)
    rim(skirt, 0.005)
    feet = boots(body, arm, C, top=0.9)
    out = [top, skirt, feet]
    if apron_on:
        ap = apron(body, arm, C, C.z(1.30), C.zl(0.20), width=0.15, mat="linen", under=[top, skirt],
                   bib=True)
        out.append(ap)
    sash = belt(body, C.z(1.08), under=out, width=0.035, buckle=None, mat="cloth2")
    for b in sash:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    out += sash
    if shawl:
        out.append(cloak(body, arm, C, C.z(1.05), mat="wool", under=out, name="shawl",
                         ragged=0.03))
    return out


def maid(body, arm, C):
    return woman(body, arm, C, apron_on=True)


def crone(body, arm, C):
    return woman(body, arm, C, hem=0.05, ragged=0.04, shawl=True)


def lady(body, arm, C):
    """A noblewoman: a fitted gown in velvet with long sleeves and a square
    neck, its skirt full to the floor and trailing, a girdle of gilt plates
    low on the hips, and a mantle from the shoulders."""
    top = tunic_body(body, arm, C, sleeve=0.95, hem=C.z(0.99), neck_drop=0.06, mat="velvet")
    skirt = loft_skirt(body, "skirt", C.z(1.06), C.zl(-0.01), flare=1.75, mat="velvet",
                       hem_wave=0.09, under=[top], rings=12)
    hang(skirt, arm, body, C, C.z(1.06), C.zl(0.0), follow=0.35)
    rim(skirt, 0.005)
    feet = boots(body, arm, C, top=0.92)
    girdle = belt(body, C.z(1.00), under=[top, skirt], width=0.022, buckle="gold", mat="gold", ease=0.012)
    for b in girdle:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    mantle = cloak(body, arm, C, C.zl(0.10), mat="wool", under=[top, skirt] + girdle, name="mantle")
    return [top, skirt, feet, mantle] + girdle


def nomad(body, arm, C):
    """A man of the desert: a long loose robe to the ankle with full
    sleeves, a broad sash wound at the waist, and soft boots."""
    parts = robe(body, arm, C, mat="cloth", hem=0.07, flare=1.35, sleeve=0.9, wide=True, name="thobe")
    feet = boots(body, arm, C, top=0.9)
    sash = belt(body, C.z(1.04), under=parts, width=0.075, buckle=None, mat="cloth2", ease=0.012)
    for b in sash:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    return parts + [feet] + sash


def troll(body, arm, C):
    """A loincloth of hide on a rope. A troll wears what it killed."""
    skirt = loft_skirt(body, "loincloth", C.z(1.02), C.zl(0.60), flare=1.12, mat="leather",
                       hem_wave=0.06, ragged=0.08, rings=6)
    hang(skirt, arm, body, C, C.z(1.02), C.zl(0.60), follow=0.6)
    rim(skirt, 0.006)
    rope = belt(body, C.z(1.03), under=[skirt], width=0.02, buckle=None, mat="linen")
    for b in rope:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    return [skirt] + rope


def _bone_rod(a, b, r0, r1, name, bone, knob=1.6, sides=6):
    """A long bone: knuckled ends and a waisted shaft."""
    a, b = V(a), V(b)
    d = b - a
    L = d.length
    o = people.ring_loft(a, d, [(0.0, r0 * knob * 0.7, r0 * knob * 0.7, r0 * knob * 0.7),
                                (L * 0.06, r0 * knob, r0 * knob, r0 * knob),
                                (L * 0.18, r0, r0, r0), (L * 0.82, r1, r1, r1),
                                (L * 0.94, r1 * knob, r1 * knob, r1 * knob),
                                (L, r1 * knob * 0.7, r1 * knob * 0.7, r1 * knob * 0.7)],
                         sides=sides, name=name, mat="bone")
    for p in o.data.polygons:
        p.use_smooth = True
    rig.set_rigid(o, bone)
    return o


def skeleton(body, arm, C):
    """Bones, rigidly on the bones they are named for. No skin at all: the
    caller throws the body away."""
    b = arm.data.bones
    hl = lambda n: b[n].head_local.copy()
    tl = lambda n: b[n].tail_local.copy()
    P = C.P
    out = []
    import heads
    sk = heads.skull(P)
    rig.set_rigid(sk, "head")
    out.append(sk)
    # Spine: neck to sacrum, bumped every vertebra.
    for (name, r) in (("neck", 0.016), ("chest", 0.019), ("spine", 0.021)):
        h, t = hl(name) + V((0, 0.03, 0)), tl(name) + V((0, 0.03, 0))
        d = t - h
        rings = []
        n = 6
        for i in range(n + 1):
            f = i / n
            rings.append((d.length * f, r * (1.25 if i % 2 else 0.9), r, r * 1.3))
        o = people.ring_loft(h, d, rings, sides=6, name="vertebrae", mat="bone")
        rig.set_rigid(o, name)
        out.append(o)
    # Ribs: hoops round the chest, narrowing up and down, open at the front
    # where the sternum is.
    top, bot = C.z(1.43), C.z(1.20)
    for i in range(7):
        t = i / 6
        z = top + (bot - top) * t
        x0, y0, y1 = section(body, z, bones=("chest", "spine"))
        rx = x0 * (0.78 + 0.18 * math.sin(math.pi * min(1, t * 1.3)))
        verts = []
        segs = 8
        for k in range(segs + 1):
            a = math.radians(-150 + 300 * k / segs)
            verts.append(V((math.sin(a) * rx, (y0 + y1) / 2 - math.cos(a) * (y1 - y0) / 2 * 0.9,
                            z - 0.02 * math.cos(a))))
        for k in range(segs):
            a, bb = verts[k], verts[k + 1]
            o = people.ring_loft(a, bb - a, [(0.0, 0.007, 0.006, 0.006), ((bb - a).length, 0.007, 0.006, 0.006)],
                                 sides=4, name="rib", mat="bone")
            rig.set_rigid(o, "chest" if t < 0.6 else "spine")
            out.append(o)
    stern = lib.box((0.026, 0.012, top - bot + 0.02), (0, section(body, (top + bot) / 2)[1] + 0.012,
                                                        (top + bot) / 2), name="sternum", mat="bone")
    rig.set_rigid(stern, "chest")
    out.append(stern)
    # Pelvis: a basin round the hips.
    pz = C.z(0.98)
    x0, y0, y1 = section(body, pz, bones=("hips",))
    pel = people.ring_loft(V((0, (y0 + y1) / 2, pz)), (0, 0, 1), [
        (-0.05, x0 * 0.45, 0.04, 0.05), (0.0, x0 * 0.66, 0.055, 0.06), (0.05, x0 * 0.78, 0.05, 0.065)],
        sides=12, side=(-1, 0, 0), name="pelvis", mat="bone", caps=False)
    people.outward(pel)
    thicken(pel, 0.012)
    rig.set_rigid(pel, "hips")
    out.append(pel)
    for t in "LR":
        out.append(_bone_rod(hl("shoulder." + t) + V((0, -0.03, 0)), tl("shoulder." + t),
                             0.009, 0.010, "clavicle", "shoulder." + t))
        out.append(_bone_rod(hl("upperarm." + t), tl("upperarm." + t), 0.012, 0.011, "humerus",
                             "upperarm." + t))
        for off in (-0.012, 0.012):
            out.append(_bone_rod(hl("forearm." + t) + V((0, off, 0)), tl("forearm." + t) + V((0, off * 0.6, 0)),
                                 0.008, 0.007, "forearm", "forearm." + t, knob=1.4))
        out.append(_bone_rod(hl("thigh." + t), tl("thigh." + t), 0.016, 0.015, "femur", "thigh." + t))
        out.append(_bone_rod(hl("shin." + t), tl("shin." + t), 0.014, 0.012, "tibia", "shin." + t))
        out.append(_bone_rod(hl("foot." + t), tl("foot." + t), 0.012, 0.009, "tarsal", "foot." + t))
        out.append(_bone_rod(hl("toe." + t), tl("toe." + t), 0.009, 0.007, "toes", "toe." + t))
        heel = hl("foot." + t) + V((0, 0.05, -0.07))
        out.append(_bone_rod(hl("foot." + t), heel, 0.011, 0.012, "heel", "foot." + t))
        # Hand: four long finger bones fanned from the wrist, and a thumb.
        h, tt = hl("hand." + t), tl("hand." + t)
        d = (tt - h)
        for (k, off) in enumerate((-0.022, -0.007, 0.008, 0.022)):
            a = h + V((0, off, 0))
            e = a + d * 1.9 + V((0, off * 0.3, 0))
            out.append(_bone_rod(a, e, 0.005, 0.004, "finger", "hand." + t, knob=1.4, sides=4))
        out.append(_bone_rod(h + V((0, -0.02, 0)), h + d * 1.1 + V((0, -0.045, 0)), 0.005, 0.004,
                             "thumb", "hand." + t, knob=1.4, sides=4))
    return out


def brute(body, arm, C):
    """A gang's troll or ogre: a sleeveless leather jerkin, too small, laced
    over the hide, the loincloth under it and a rope for a belt."""
    top = tunic_body(body, arm, C, sleeve=-0.9, hem=C.z(0.95), mat="leather", offset=0.012, neck_drop=0.05,
                     name="jerkin")
    skirt = loft_skirt(body, "loincloth", C.z(1.02), C.zl(0.60), flare=1.12, mat="leather",
                       hem_wave=0.06, ragged=0.08, rings=6, under=[top])
    hang(skirt, arm, body, C, C.z(1.02), C.zl(0.60), follow=0.6)
    rim(skirt, 0.006)
    rope = belt(body, C.z(1.03), under=[top, skirt], width=0.02, buckle=None, mat="linen")
    for b in rope:
        hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    return [top, skirt] + rope


# --- the heroes ------------------------------------------------------------------------
#
# What a player wears (people.js youngPlayer; no mobile is ever given one).
# The townsperson archetypes above are what a crowd wears, and a flat block of
# robe with a cord round it is right for a crowd; a player is the one figure
# the camera stays on, and has to read at thirty metres as a silhouette --
# shoulders wider than the waist, something at the collar, something swinging
# at the hem -- and at three as a colour with a second colour on it. So these
# four are built the other way round: the cloth is plain and the shape is made
# of pieces on it.
#
# Bones: pieces cut from the body (`shell`) carry its weights; everything
# that hangs below the belt (`hem_band`, `ribbon`, the skirts) is weighted as a
# skirt so it swings with the stride and the actors.js spring; what lies on
# the chest or shoulders (`strap`, `mantle`, `collar`) takes the nearest body
# vertex's weights; plate (`pauldron`, `vambrace`) is wholly one bone. The
# upper arm's own net scale at run time is 1 (actors.js BUILDS gives the
# clavicle and chest what it takes back off the arm), so a plate rigid to it
# needs no allowance for the athletic build.

def hem_band(body, arm, C, skirt, hem, height, mat, follow, top=None, name="hem_band"):
    """A band of a second cloth round the foot of a skirt: the same
    silhouette (it reads its radius off the skirt itself, flare 1) standing a
    centimetre proud, weighted as the skirt is."""
    # Cast a hair above the hem, which is the skirt's own bottom edge and a
    # ray along it can slip through; the last ring is let down afterwards.
    band = loft_skirt(body, name, hem + height, hem + 0.008, flare=1.0, mat=mat, ease=0.011,
                      rings=3, under=[skirt], smooth=False)
    low = min(v.co.z for v in band.data.vertices)
    for v in band.data.vertices:
        if v.co.z < low + 1e-4:
            v.co.z = hem - 0.004
    hang(band, arm, body, C, top if top is not None else C.z(1.00), hem, follow=follow)
    rim(band, 0.006)
    return band


def ribbon(body, arm, C, top, hem, x, width, mat="cloth2", under=(), name="ribbon", gap=0.012,
           taper=0.0, vee=0.0, drift=0.0, rows=12, cols=3, belt_z=None, follow=0.45, sgn=-1,
           curve=0.012):
    """A strip down the front (sgn -1) or back (+1) of whatever is worn, from
    `top` to `hem`, centred `x` off the middle: a stole, a placket, the ends
    of a sash, a band at the foot of a tabard. As `apron`: it lies on the
    surface down to the belt and hangs straight below it. `taper` narrows it
    towards the hem, `vee` cuts the hem to a swallow-tail, `drift` swings the
    foot out sideways."""
    tree = bvh([body] + list(under))
    belt_z = belt_z if belt_z is not None else C.z(1.04)
    verts, faces = [], []
    hung = None
    for r in range(rows + 1):
        t = r / rows
        z = top + (hem - top) * t
        w = width * (1.0 - taper * t)
        xc = x + drift * t * t
        hits = [drape(tree, xc + u * w * 0.9, z, sgn, None) for u in (-1, -0.5, 0, 0.5, 1)]
        hits = [h for h in hits if h is not None]
        front = (min(hits) if sgn < 0 else max(hits)) if hits else sgn * 0.13
        if z < belt_z:
            if hung is None:
                hung = front
            front = min(front, hung) if sgn < 0 else max(front, hung)
            front += sgn * 0.008 * ((belt_z - z) / max(1e-3, belt_z - hem))
        for c in range(cols + 1):
            u = -1.0 + 2.0 * c / (cols)
            zz = z + (vee * (1.0 - abs(u)) if r == rows else 0.0)
            verts.append((xc + u * w, front + sgn * gap - sgn * curve * u * u, zz))
    for r in range(rows):
        for c in range(cols):
            i = r * (cols + 1) + c
            faces.append((i, i + 1, i + 2 + cols, i + 1 + cols) if sgn < 0 else
                         (i, i + 1 + cols, i + 2 + cols, i + 1))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, mat)
    people.outward(obj)
    for p in obj.data.polygons:
        p.use_smooth = True
    thicken(obj, 0.005)
    hang(obj, arm, body, C, belt_z - 0.02, hem, follow=follow)
    return obj


def strap(body, arm, C, p0, p1, width, mat="leather", under=(), name="strap", gap=0.010,
          sgn=-1, steps=9):
    """A band laid across the chest (sgn -1) or back (+1) from the (x, z) of
    `p0` to that of `p1`, following the surface a ray finds under every
    point of its edges: a bandolier, a jerkin's lacing. Weighted as the
    trunk under it."""
    tree = bvh([body] + list(under))
    d = V((p1[0] - p0[0], p1[1] - p0[1], 0.0))
    n = V((-d.y, d.x, 0.0)).normalized() * (width / 2)
    verts, faces = [], []
    for i in range(steps + 1):
        t = i / steps
        cx, cz = p0[0] + d.x * t, p0[1] + d.y * t
        for s in (-1, 1):
            x, z = cx + n.x * s, cz + n.y * s
            y = drape(tree, x, z, sgn, sgn * 0.12)
            verts.append((x, y + sgn * gap, z))
    for i in range(steps):
        a = 2 * i
        faces.append((a, a + 1, a + 3, a + 2))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, mat)
    people.outward(obj)
    for p in obj.data.polygons:
        p.use_smooth = True
    thicken(obj, 0.006)
    transfer_weights(obj, body, lambda co, b: limb(b) in ("chest", "spine", "hips", "shoulder"))
    return obj


def stud(body, C, x, z, mat="gold", under=(), r=0.014, sgn=-1, name="buckle"):
    """A buckle or boss on the chest at (x, z): a flat gilt plate on whatever
    surface a ray finds there, wholly on the chest bone."""
    tree = bvh([body] + list(under))
    y = drape(tree, x, z, sgn, sgn * 0.12)
    o = lib.box((r * 2, 0.012, r * 1.6), (x, y + sgn * 0.012, z), name=name, mat=mat)
    rig.set_rigid(o, "chest")
    return o


def collar(body, arm, C, rise=0.060, flare=0.032, mat="cloth", name="collar", lift=0.0):
    """A stand collar, stiff and open at the top: a tube round the neck from
    inside the shoulders' slope up to the jaw, flaring out, so the head sits
    in it."""
    rn = C.P["neck"]
    z0 = C.neck - 0.04
    x0, y0, y1 = section(body, C.neck - 0.005, bones=("neck", "chest"))
    cy = (y0 + y1) / 2
    top = rise + 0.04
    L = lift
    rings = [(0.0, rn + 0.060, rn + 0.052, rn + 0.044, 0, 0, 2.2),
             (0.04, rn + 0.030 + L, rn + 0.030 + L, rn + 0.026 + L, 0, 0, 2.2),
             (0.04 + rise * 0.6, rn + 0.030 + flare * 0.3 + L, rn + 0.032 + L, rn + 0.028 + L, 0, 0, 2.2),
             (top, rn + 0.030 + flare + L, rn + 0.034 + flare + L, rn + 0.028 + flare * 0.6 + L, 0, 0, 2.2)]
    o = people.ring_loft((0, cy, z0), (0, 0, 1), rings, sides=24, side=(1, 0, 0), name=name,
                         mat=mat, caps=False)
    for p in o.data.polygons:
        p.use_smooth = True
    thicken(o, 0.007)
    transfer_weights(o, body, lambda co, b: limb(b) in ("chest", "neck", "shoulder", "spine"))
    return o


def mantle(body, arm, C, drop=0.17, mat="cloth", name="mantle", stand=0.026, out=0.016, lift=0.0):
    """A short cape over the shoulders, a hand's breadth below them: what
    turns a robe's narrow shoulders into a V. Lofted by hand, because rays
    would shrink-wrap the arms and the neck and leave it a lumpy hood; it
    stands `out` clear of the deltoid all the way down, and `stand` above
    the neck's base. Weighted from the body, then the arm's share of it
    halved and given to the clavicle: a cape moves with the shoulder and
    not with every swing of the arm."""
    P = C.P
    sj = C.b["upperarm.L"].head_local
    rn = P["neck"]
    xo = sj.x + P["delt"]
    z0 = C.neck + stand
    x0, y0, y1 = section(body, C.neck - 0.03, bones=("neck", "chest", "spine"))
    cy = 0.0
    fz, bk = abs(y0) + 0.02, abs(y1) + 0.02
    fz = max(fz, P["chest"][1] + 0.016)
    bk = max(bk, P["chest"][2] + 0.016)
    L = lift
    rings = [(0.00, rn + 0.030 + L, rn + 0.040 + L, rn + 0.030 + L, 0, 0, 2.2),
             (0.020, 0.55 * xo + 0.04 + L, fz * 0.80 + L, bk * 0.80 + L, 0, 0, 2.3),
             (0.040, xo - 0.005 + L, fz * 0.96 + L, bk * 0.96 + L, 0, 0, 2.5),
             (0.075, xo + out + L, fz + 0.012 + L, bk + 0.012 + L, 0, 0, 2.6),
             (0.075 + (drop - 0.075 - 0.035) * 0.6, xo + out + 0.010 + L, fz + 0.022 + L, bk + 0.020 + L, 0, 0, 2.6),
             (drop - 0.035, xo + out + 0.016 + L, fz + 0.028 + L, bk + 0.026 + L, 0, 0, 2.6),
             (drop, xo + out + 0.022 + L, fz + 0.032 + L, bk + 0.030 + L, 0, 0, 2.6)]
    o = people.ring_loft((0, cy, z0), (0, 0, -1), rings, sides=28, side=(1, 0, 0), name=name,
                         mat=mat, caps=False)
    for p in o.data.polygons:
        p.use_smooth = True
    transfer_weights(o, body, lambda co, b: limb(b) in ("chest", "neck", "shoulder", "spine", "upperarm"))
    shift_arm_weights(o, 0.5)
    rim(o, 0.006)
    return o


def shift_arm_weights(obj, give):
    """Move `give` of every upper-arm weight on a mesh to the clavicle of the
    same side."""
    for t in "LR":
        ua = obj.vertex_groups.get("upperarm." + t)
        if ua is None:
            continue
        sh = obj.vertex_groups.get("shoulder." + t) or obj.vertex_groups.new(name="shoulder." + t)
        for v in obj.data.vertices:
            w = 0.0
            for g in v.groups:
                if g.group == ua.index:
                    w = g.weight
            if w > 0:
                moved = w * give
                ua.add([v.index], w - moved, "REPLACE")
                cur = 0.0
                for g in v.groups:
                    if g.group == sh.index:
                        cur = g.weight
                sh.add([v.index], cur + moved, "REPLACE")
    return obj


def limb_band(body, arm, C, bone, lo, hi, offset, mat, name, rings=2, flare=0.0, sides=12,
              thick=0.005):
    """A ring of cloth, leather or plate round a limb from `lo` to `hi` of
    its bone, fitted to the skin by rays out from the bone's axis and
    standing `offset` off it. A shell cut from the body has a saw-tooth
    where it ends -- the decimated limb is a few rows of long triangles --
    and a band made of its own rings has none, which is why every cuff,
    bracer, greave and boot top here is one. Wholly on the bone. `flare`
    opens the `hi` end out like a bell."""
    bb = C.b[bone]
    h, tl = bb.head_local, bb.tail_local
    ax = (tl - h)
    length = ax.length
    ax.normalize()
    u = V((1.0, 0.0, 0.0))
    if abs(ax.dot(u)) > 0.9:
        u = V((0.0, 1.0, 0.0))
    u = (u - ax * ax.dot(u)).normalized()
    v = ax.cross(u)
    tree = bvh([body], trunk_only=False)
    verts, faces = [], []
    radii = []
    for k in range(rings + 1):
        f = lo + (hi - lo) * k / rings
        c = h + ax * (length * f)
        row = []
        for i in range(sides):
            a = 2 * math.pi * i / sides
            d = u * math.cos(a) + v * math.sin(a)
            loc, _, _, _ = tree.ray_cast(c, d, 0.3)
            row.append((loc - c).length if loc is not None else 0.04)
        radii.append([(row[i - 1] + 2 * row[i] + row[(i + 1) % sides]) / 4 for i in range(sides)])
    for k in range(rings + 1):
        f = lo + (hi - lo) * k / rings
        c = h + ax * (length * f)
        for i in range(sides):
            a = 2 * math.pi * i / sides
            d = u * math.cos(a) + v * math.sin(a)
            r = radii[k][i] + offset + flare * (k / rings) ** 2
            verts.append(tuple(c + d * r))
    for k in range(rings):
        for i in range(sides):
            j = (i + 1) % sides
            faces.append((k * sides + i, k * sides + j, (k + 1) * sides + j, (k + 1) * sides + i))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, mat)
    people.outward(obj)
    for p in obj.data.polygons:
        p.use_smooth = True
    rig.set_rigid(obj, bone)
    rim(obj, thick)
    return obj


def cuffs_of(body, arm, C, lo, hi, mat, offset=0.022, name="cuff", flare=0.0):
    """A band round each wrist, between `lo` and `hi` of the forearm."""
    return [limb_band(body, arm, C, "forearm." + t, lo, hi, offset, mat, "%s_%s" % (name, t),
                      flare=flare) for t in "LR"]


def vambraces(body, arm, C, mat="steel", lo=0.12, hi=0.88, offset=0.022, name="vambrace"):
    return cuffs_of(body, arm, C, lo, hi, mat, offset, name)


def pauldron(body, arm, C, mat="steel", trim="gold", lames=3, r0=0.098, name="pauldron"):
    """A shoulder of layered plates, a dome on the point of the shoulder and
    `lames` bands running down the arm, each a little smaller and hiding the
    top of the next -- the part of a figure the eye finds first. Wholly on
    the upper arm. Each is a closed ring round the arm, mostly inside the
    chest where it cannot be seen."""
    out = []
    for t in "LR":
        bb = C.b["upperarm." + t]
        h, tl = bb.head_local, bb.tail_local
        axis = (tl - h).normalized()
        o = people.ring_loft(h, axis, [
            (-0.050, 0.020, 0.020), (-0.040, 0.058, 0.058), (-0.020, 0.086, 0.086),
            (0.010, r0, r0), (0.045, r0 - 0.002, r0 - 0.002), (0.072, r0 - 0.008, r0 - 0.008)],
            sides=14, side=(0, 1, 0), name="%s_%s" % (name, t), mat=mat, caps=False)
        parts = [o]
        for i in range(lames - 1):
            s = 0.060 + i * 0.048
            rr = r0 - 0.012 - i * 0.010
            parts.append(people.ring_loft(h, axis, [
                (s, rr - 0.004, rr - 0.004), (s + 0.020, rr + 0.002, rr + 0.002),
                (s + 0.062, rr - 0.006, rr - 0.006)],
                sides=14, side=(0, 1, 0), name="%s%d_%s" % (name, i, t), mat=mat, caps=False))
        if trim:
            parts.append(people.ring_loft(h, axis, [
                (0.074, r0 - 0.006, r0 - 0.006), (0.082, r0 - 0.005, r0 - 0.005)],
                sides=14, side=(0, 1, 0), name="%s_trim_%s" % (name, t), mat=trim, caps=False))
        for p in parts:
            for q in p.data.polygons:
                q.use_smooth = True
            rig.set_rigid(p, "upperarm." + t)
            rim(p, 0.006)
        out += parts
    return out


def boot_cuffs(body, arm, C, top, mat="leather", up=0.10, down=0.13, offset=0.024, name="boot_cuff"):
    """The turned-down top of a boot: a band round the leg across the
    boot's edge -- `up` of the shin above it, `down` below -- which hides the
    saw-tooth the edge of a cut boot has."""
    return [limb_band(body, arm, C, "shin." + t, top - up, top + down, offset, mat,
                      "%s_%s" % (name, t), rings=2) for t in "LR"]


def greaves(body, arm, C, mat="steel", lo=0.10, hi=0.72, offset=0.022):
    return [limb_band(body, arm, C, "shin." + t, lo, hi, offset, mat, "greave_" + t, rings=4,
                      sides=14) for t in "LR"]


def hero_boots(body, arm, C, top, mat="leather", cuff=True):
    """A tall boot with a clean top: the shell of the foot and ankle
    (`boots`), and the shaft above it a band of its own from `top` of the
    shin to the ankle, so the edge a cut boot has -- the saw-tooth, with the
    breeches showing through it -- is nowhere. A cuff is turned over the
    top."""
    foot = boots(body, arm, C, top=0.80, mat=mat)
    out = [foot]
    out += [limb_band(body, arm, C, "shin." + t, top, 0.99, 0.013, mat, "shaft_" + t, rings=5,
                      sides=14) for t in "LR"]
    if cuff:
        out += boot_cuffs(body, arm, C, top + 0.06, mat=mat, up=0.06, down=0.07, offset=0.022)
    return out


def pouch(body, arm, C, x, y, z, size=(0.075, 0.05, 0.085), mat="leather", name="pouch"):
    """A belt pouch: a box with a flap, on the hip bone. Not weighted as a
    skirt -- it hangs from the belt and does not swing out."""
    o = lib.box(size, (x, y, z), name=name, mat=mat)
    flap = lib.box((size[0] * 1.05, size[1] * 1.08, size[2] * 0.36), (x, y, z + size[2] * 0.34),
                   name=name + "_flap", mat=mat)
    for q in (o, flap):
        rig.set_rigid(q, "hips")
    return [o, flap]


def hero_belt(body, arm, C, z, under, mat="leather", width=0.05, buckle="gold", ease=0.012):
    bt = belt(body, z, under=under, width=width, mat=mat, buckle=buckle, ease=ease)
    for b in bt:
        # The buckle is a plate on the hips. Hung like the belt it came out
        # wholly on skirt2 (the shin's twin), and at every sprint stride the
        # heel's kick swung it round the knee and out behind the hips like a
        # paddle. The townsfolk's buckles still hang that way.
        if b.name.startswith("buckle"):
            rig.set_rigid(b, "hips")
        else:
            hang(b, arm, body, C, C.z(0.80), C.zl(0.7))
    return bt


def hero_mage(body, arm, C):
    """A mage, cut to be looked at: a fitted robe with a stiff standing
    collar, a short mantle over the shoulders, a wide band of a second cloth
    at the hem and the cuffs and a placket down the front, a sash knotted at
    the hip with two ends swinging."""
    hem = 0.035
    top, skirt = robe(body, arm, C, mat="cloth", hem=hem, flare=1.42, sleeve=0.94)
    feet = boots(body, arm, C, top=0.92)
    parts = [top, skirt, feet]
    parts.append(hem_band(body, arm, C, skirt, C.zl(hem), 0.15, "cloth2", 0.42))
    parts += cuffs_of(body, arm, C, 0.55, 1.0, "cloth2", offset=0.020, flare=0.016)
    plk = ribbon(body, arm, C, C.z(1.30), C.zl(hem) + 0.148, 0.0, 0.020, "cloth2",
                 under=[top, skirt], gap=0.007, rows=16)
    bt = hero_belt(body, arm, C, C.z(1.06), [top, skirt, plk], mat="cloth2", width=0.06, buckle="gold")
    ends = [ribbon(body, arm, C, C.z(1.06), C.zl(0.34), 0.11, 0.030, "cloth2", under=[top, skirt] + bt,
                   name="sash_a", vee=0.025, drift=0.020, taper=0.15, follow=0.5),
            ribbon(body, arm, C, C.z(1.06), C.zl(0.46), 0.145, 0.028, "cloth2", under=[top, skirt] + bt,
                   name="sash_b", vee=0.025, drift=0.030, taper=0.15, follow=0.5)]
    cape = mantle(body, arm, C, drop=0.17, mat="cloth")
    cband = mantle(body, arm, C, drop=0.17, mat="cloth2", name="mantle_band", lift=0.006)
    # The band is the foot of the same mantle, a little proud of it:
    # everything above is cut away.
    cut(cband, below=None, above=C.neck + 0.026 - 0.17 + 0.0355)
    col = collar(body, arm, C, mat="cloth")
    clc = collar(body, arm, C, rise=0.060, mat="cloth2", name="collar_trim", lift=0.004)
    cut(clc, below=C.neck + 0.060 - 0.022)
    return parts + [plk] + bt + ends + [cape, cband, col, clc]


def cut(obj, above=None, below=None):
    """Delete every face of a mesh with a vertex above `above` or below
    `below`, and keep the rest: how a band is taken off the foot or the lip
    of a lofted garment."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    dead = [f for f in bm.faces if any((above is not None and v.co.z > above) or
                                       (below is not None and v.co.z < below) for v in f.verts)]
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def torso_shell(body, arm, C, mat="cloth", hem=None, offset=0.020, neck_drop=0.04, name="jerkin"):
    """The body's trunk from the neckline to `hem` and no sleeves: a
    jerkin, a surcoat, a waistcoat. The armhole is wherever the body's own
    weights change from the chest to the arm, which a pauldron or a sleeve
    over it covers."""
    hem = hem if hem is not None else C.z(0.93)
    neck = C.neckline(neck_drop)

    def keep(co, bone):
        if co.z < hem - 0.001 or co.z > C.neck - 0.02:
            return False
        l = limb(bone)
        if l in ("chest", "spine", "hips"):
            return above(neck, co) or abs(co.x) > 0.10
        # The top of the chest is the clavicles' by weight.
        if l == "shoulder":
            return abs(co.x) < 0.115 and above(neck, co)
        return l == "thigh" and co.z >= hem
    return shell(body, arm, name, keep, offset=offset, mat=mat,
                 planes=[neck, (V((0, 0, hem)), V((0, 0, 1)))])


def hero_priest(body, arm, C):
    """A battle cleric: a tunic to below the knee over leather breeches and
    boots, a tabard in ivory with a gold band at the foot, a long stole of
    gold from the neck to the shin, steel on the shoulders and forearms, and
    the holy symbol over it all."""
    top = tunic_body(body, arm, C, sleeve=0.94, hem=C.z(0.93), mat="cloth", offset=0.012,
                     neck_drop=0.05, name="tunic")
    skirt = loft_skirt(body, "tunic_skirt", C.z(1.00), C.zl(0.34), flare=1.30, mat="cloth",
                       hem_wave=0.06, under=[top], rings=12)
    hang(skirt, arm, body, C, C.z(1.00), C.zl(0.34), follow=0.5)
    rim(skirt, 0.006)
    legs = hose(body, arm, C, mat="leather")
    parts = [top, skirt, legs] + hero_boots(body, arm, C, 0.40)
    parts += cuffs_of(body, arm, C, 0.62, 1.0, "cloth2", offset=0.020)
    tb = tabard(body, arm, C, C.zl(0.42), width=0.120, mat="linen", under=[top, skirt], gap=0.010)
    parts += tb
    for sgn, tag in ((-1, "f"), (1, "b")):
        parts.append(ribbon(body, arm, C, C.zl(0.42) + 0.12, C.zl(0.42) - 0.004, 0.0, 0.121, "cloth2",
                            under=[top, skirt] + tb, gap=0.010, name="tabard_band_" + tag, sgn=sgn,
                            rows=2, cols=6, follow=0.45))
    bt = hero_belt(body, arm, C, C.z(1.05), [top, skirt] + tb, width=0.055, buckle="gold")
    parts += bt
    for sx in (-1, 1):
        parts.append(ribbon(body, arm, C, C.neck - 0.012, C.zl(0.45), sx * 0.072, 0.036, "cloth2",
                            under=[top, skirt] + tb + bt, gap=0.009, rows=20, taper=-0.30, vee=0.03,
                            curve=0.004,
                            name="stole_" + ("l" if sx > 0 else "r"), follow=0.5))
    parts += holy_symbol(body, arm, C, under=[top] + tb)
    parts += pauldron(body, arm, C, mat="steel", trim="gold", lames=2, r0=0.092)
    parts += vambraces(body, arm, C, lo=0.20, hi=0.58, offset=0.017)
    return parts


def hero_rogue(body, arm, C):
    """A thief: a shirt, a fitted leather jerkin over it laced across the
    chest with a bandolier and its buckles, a wide belt with pouches, leather
    bracers, tall boots turned down at the top, and a short half-cloak
    pinned over the left shoulder."""
    shirt = tunic_body(body, arm, C, sleeve=0.80, hem=C.z(0.93), mat="cloth", offset=0.010,
                       neck_drop=0.05, name="shirt")
    jerkin = torso_shell(body, arm, C, mat="leather", hem=C.z(0.95), offset=0.020, name="jerkin")
    flaps = loft_skirt(body, "jerkin_skirt", C.z(1.00), C.zl(0.80), flare=1.16, mat="leather",
                       hem_wave=0.05, under=[shirt, jerkin], rings=4, sides=20)
    hang(flaps, arm, body, C, C.z(1.00), C.zl(0.80), follow=0.6)
    rim(flaps, 0.006)
    skirt = loft_skirt(body, "shirt_skirt", C.z(1.00), C.zl(0.66), flare=1.10, mat="cloth",
                       under=[shirt, jerkin], rings=6, sides=20)
    hang(skirt, arm, body, C, C.z(1.00), C.zl(0.66), follow=0.6)
    rim(skirt, 0.006)
    legs = hose(body, arm, C, mat="cloth2")
    parts = [shirt, jerkin, skirt, flaps, legs] + hero_boots(body, arm, C, 0.28)
    parts += cuffs_of(body, arm, C, 0.35, 0.98, "leather", offset=0.019, name="bracer")
    parts += pauldron(body, arm, C, mat="leather", trim=None, lames=1, r0=0.084, name="spaulder")
    lace = strap(body, arm, C, (0.095, C.z(1.38)), (-0.105, C.z(1.08)), 0.040, "leather",
                 under=[jerkin, shirt], name="bandolier")
    parts.append(lace)
    parts.append(strap(body, arm, C, (0.0, C.neck - 0.07), (0.0, C.z(1.06)), 0.016, "cloth2",
                       under=[jerkin, shirt, lace], name="lacing", gap=0.012))
    parts.append(stud(body, C, 0.0, C.z(1.20), "gold", under=[jerkin, shirt, lace], r=0.013, name="clasp"))
    parts.append(stud(body, C, 0.045, C.z(1.30), "gold", under=[jerkin, shirt, lace], r=0.010, name="clasp"))
    bt = hero_belt(body, arm, C, C.z(1.03), [jerkin, flaps, skirt], width=0.065, buckle="iron", ease=0.014)
    parts += bt
    x0, y0, y1 = section(body, C.z(1.03))
    parts += pouch(body, arm, C, x0 + 0.030, -0.040, C.z(1.00) - 0.05)
    parts += pouch(body, arm, C, -(x0 + 0.030), -0.070, C.z(1.00) - 0.05, size=(0.060, 0.045, 0.070))
    parts += pouch(body, arm, C, 0.0, y1 + 0.04, C.z(1.00) - 0.04, size=(0.10, 0.05, 0.07), name="satchel")
    # Over the left shoulder and down the back: only the arc from the left
    # arm's side round to the middle of the back.
    parts.append(cloak(body, arm, C, C.zl(0.60), mat="wool", under=[shirt, jerkin] + bt,
                       name="half_cloak", arc=(-12, 112), ragged=0.05))
    return parts


def hero_guard(body, arm, C):
    """A warrior: mail to the elbow and mid-thigh under a short surcoat in a
    strong colour with a band at its foot, layered pauldrons, steel
    vambraces and greaves, leather breeches and boots turned down at the
    top, and a wide belt with a gilt buckle. Nothing of the watch's tabard,
    blue mail shirt and bare shins."""
    mail = tunic_body(body, arm, C, sleeve=0.50, hem=C.z(0.93), mat="mail", offset=0.012,
                      neck_drop=0.02, name="mail")
    mskirt = loft_skirt(body, "mail_skirt", C.z(1.00), C.zl(0.70), flare=1.10, mat="mail",
                        under=[mail], rings=5, sides=20)
    hang(mskirt, arm, body, C, C.z(1.00), C.zl(0.70), follow=0.6)
    rim(mskirt, 0.006)
    # One loft from the neck to the hem, with no sleeves: the arms stand out
    # of it at the sides, and the camail hides where it meets the shoulders.
    coat = loft_skirt(body, "surcoat", C.z(1.22), C.zl(0.70), flare=1.16, mat="cloth",
                      ease=0.022, hem_wave=0.05, under=[mail, mskirt], rings=12, sides=24)
    hang(coat, arm, body, C, C.z(1.00), C.zl(0.70), follow=0.55)
    rim(coat, 0.006)
    sk = coat
    legs = hose(body, arm, C, mat="leather")
    parts = [mail, mskirt, coat, legs] + hero_boots(body, arm, C, 0.62)
    parts.append(mantle(body, arm, C, drop=0.09, mat="mail", name="camail", out=0.004))
    parts.append(hem_band(body, arm, C, sk, C.zl(0.70), 0.07, "cloth2", 0.55, name="surcoat_band"))
    parts += greaves(body, arm, C, lo=0.08, hi=0.52)
    parts += vambraces(body, arm, C, lo=0.30, hi=0.96, offset=0.017)
    parts += pauldron(body, arm, C, mat="steel", trim="cloth2", lames=3, r0=0.104)
    bt = hero_belt(body, arm, C, C.z(1.04), [coat, mail], width=0.075, buckle="gold", ease=0.016)
    parts += bt
    parts.append(stud(body, C, 0.0, C.z(1.04), "gold", under=[coat, mail] + bt, r=0.030, name="buckle_plate"))
    return parts


DRESS = {"brute": brute, "lady": lady, "nomad": nomad, "skeleton": skeleton, "troll": troll, "woman": woman, "maid": maid, "crone": crone, "peasant": peasant, "guard": guard, "merchant": merchant, "smith": smith,
         "priest": priest, "mage": mage, "rogue": rogue, "beggar": beggar, "noble": noble,
         "knight": knight, "zombie": zombie, "ghost": ghost,
         "hero_mage": hero_mage, "hero_priest": hero_priest, "hero_rogue": hero_rogue,
         "hero_guard": hero_guard}



def dress(name, body, arm, P):
    """One archetype as one skinned mesh: the body with the covered skin cut
    away, and everything it wears, joined."""
    C = Cuts(arm, P)
    skin = copy_object(body, "arch_" + name)
    pieces = DRESS[name](skin, arm, C)
    if name == "skeleton":
        # Nothing of the body is kept; the join still needs it as the object
        # carrying the rig, so it goes in empty.
        bm = bmesh.new()
        bm.to_mesh(skin.data)
        bm.free()
    else:
        cover(skin, pieces, deep=[p for p in pieces if p.name.split(".")[0].endswith("skirt")])
    import os
    if os.environ.get("HUMANS_DEBUG"):
        print("  PIECES", name, people.tri_count(skin), [(p.name, people.tri_count(p)) for p in pieces])
    for p in pieces:
        for m in list(p.modifiers):
            p.modifiers.remove(m)
        p.parent = None
    out = people.join([skin] + pieces, "arch_" + name)
    return out


# --- head pieces ------------------------------------------------------------------------
#
# Built on a fresh copy of the skull rather than cut from the body, because
# they are mixed per person: any hair with any beard under any hat. Each is
# wholly on the head bone. Coordinates below are about the eye line, in a
# man's head's metres, scaled per head.

def _skull(P):
    parts = people.head(P)
    skull = parts[0]
    for o in parts[1:]:
        bpy.data.objects.remove(o, do_unlink=True)
    return skull


def _local(P, co):
    c = people.head_center(P)
    hw, hd, hh = P["head"]
    return V(((co.x - c.x) * 0.077 / hw, (co.y - c.y) * 0.100 / hd, (co.z - c.z) * 0.118 / hh))


def hairline(theta):
    """Height of the hairline (about the eye line) all round the head, by
    angle from the front: a forehead, temples, clear over the ears, down
    the back to the nape."""
    a = abs(math.degrees(theta))
    return people._interp([(0, 0.060), (35, 0.052), (62, 0.030), (80, 0.018), (98, 0.016),
                           (118, -0.030), (150, -0.058), (180, -0.066)], a)


def _theta(l):
    return math.atan2(l.x, -l.y)


def cap(P, name, keep, push, mat="hair", thick=0.004, smooth=True, bone="head", edge=None):
    """A piece grown out of the skull: the faces `keep(local)` accepts,
    pushed out along the normal by `push(local)`. `edge(local)` is the height
    the open edge should lie at, where there is one: the rings of the skull
    run level and a hairline cut across them comes out in stairs."""
    skull = _skull(P)
    skull.name = name
    bm = bmesh.new()
    bm.from_mesh(skull.data)
    bm.normal_update()
    keepv = [keep(_local(P, v.co)) for v in bm.verts]
    dead = [f for f in bm.faces if not all(keepv[v.index] for v in f.verts)]
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    if edge:
        c = people.head_center(P)
        hh = P["head"][2]
        for v in bm.verts:
            if v.is_boundary:
                l = _local(P, v.co)
                target = edge(l)
                if target is not None and abs(target - l.z) < 0.02:
                    # Not a ruled line: hair grows in locks, and a hairline
                    # cut clean round the skull is what made every head of
                    # hair read as a leather cap. A few millimetres of ragged
                    # fringe, fixed by angle so both sides of a face agree.
                    th = _theta(l)
                    ragged = 0.004 * math.sin(th * 23.0) + 0.0025 * math.sin(th * 41.0 + 1.3)
                    v.co.z = c.z + (target - abs(ragged)) * hh / 0.118
    bm.normal_update()
    # Lumps: hair is never an even shell, and a little unevenness in its
    # thickness is what catches the light as locks rather than as a dome.
    def lump(co):
        return 0.0018 * (math.sin(co.x * 150.0 + co.z * 90.0) + math.sin(co.y * 170.0 - co.z * 60.0)) \
            if mat == "hair" else 0.0
    moves = [(v, v.normal.copy() * (push(_local(P, v.co)) + lump(v.co))) for v in bm.verts]
    for v, d in moves:
        v.co += d
    bm.to_mesh(skull.data)
    bm.free()
    skull.data.materials.clear()
    skull.data.materials.append(lib.material(mat))
    for p in skull.data.polygons:
        p.use_smooth = smooth
    if thick:
        rim(skull, thick)
    rig.set_rigid(skull, bone)
    return skull


# Hair and beards are hair.py's: sculpted locks over a dark mass, grown on
# the face of the body's sex. These are the names the viewer knows them by.

def _hair():
    import hair
    import heads
    importlib.reload(hair)
    return hair, heads


def hair_short(P):
    hair, heads = _hair()
    return hair.style_short(heads.spec_for(P), P, "hair_short")


def hair_crop(P):
    hair, heads = _hair()
    return hair.style_crop(heads.spec_for(P), P, "hair_crop")


def hair_long(P):
    hair, heads = _hair()
    S = heads.spec_for(P)
    # A man's to the collar, a woman's past her shoulders.
    return hair.style_long(S, P, "hair_long", length=0.30 if S["sex"] == "f" else 0.17)


def hair_fringe(P):
    hair, heads = _hair()
    return hair.style_fringe(heads.spec_for(P), P, "hair_fringe")


def hair_bun(P):
    hair, heads = _hair()
    return hair.style_bun(heads.spec_for(P), P, "hair_bun")


def hair_braid(P):
    hair, heads = _hair()
    return hair.style_braid(heads.spec_for(P), P, "hair_braid")


def hair_tail(P):
    hair, heads = _hair()
    S = heads.spec_for(P)
    return hair.style_tail(S, P, "hair_tail", length=0.26 if S["sex"] == "f" else 0.18)


def hair_swept(P):
    hair, heads = _hair()
    return hair.style_swept(heads.spec_for(P), P, "hair_swept")


def hair_undercut(P):
    hair, heads = _hair()
    return hair.style_undercut(heads.spec_for(P), P, "hair_undercut")


def hair_warrior(P):
    hair, heads = _hair()
    return hair.style_warrior(heads.spec_for(P), P, "hair_warrior")


def hair_ponyhigh(P):
    hair, heads = _hair()
    return hair.style_ponyhigh(heads.spec_for(P), P, "hair_ponyhigh")


def hair_crown(P):
    hair, heads = _hair()
    return hair.style_crown(heads.spec_for(P), P, "hair_crown")


def hair_waves(P):
    hair, heads = _hair()
    return hair.style_waves(heads.spec_for(P), P, "hair_waves")


def beard_full(P):
    hair, heads = _hair()
    return hair.style_beard(heads.spec_for(P), P, "beard_full", "full")


def beard_short(P):
    hair, heads = _hair()
    return hair.style_beard(heads.spec_for(P), P, "beard_short", "short")


def moustache(P):
    hair, heads = _hair()
    return hair.style_beard(heads.spec_for(P), P, "moustache", "moustache")


def hood(P, name="hood", mat="cloth"):
    """A hood up: the skull covered, the face open, and a fall of cloth to
    the shoulders. The top is on the head; the fall blends into the neck
    and chest so the hood does not lift off the shoulders when he looks down."""
    def keep(l):
        a = abs(math.degrees(_theta(l)))
        face = a < 58 and -0.10 < l.z < 0.070
        return not face and l.z > -0.105
    h = cap(P, name, keep, lambda l: 0.022 + 0.010 * max(0.0, l.z / 0.118), mat=mat, thick=0.008)
    c = people.head_center(P)
    hw, hd, hh = P["head"]
    # A peak at the back of the crown, the way a hood hangs off the head.
    for v in h.data.vertices:
        l = _local(P, v.co)
        if l.y > 0.02 and l.z > 0.04:
            v.co.y += 0.018 * (l.z / 0.118) * (l.y / 0.1)
            v.co.z += 0.006 * (l.y / 0.1)
    # The fall: a flared tube from under the jaw to the shoulders.
    nb = P["neck_base"]
    rings = [(0.0, hw + 0.020, hd * 0.55, hd + 0.02, 0, 0.01, 2.0),
             ((c.z - hh * 0.9) - nb + 0.04, hw + 0.045, hd * 0.8 + 0.02, hd + 0.045, 0, 0.012, 2.1),
             ((c.z - hh * 0.9) - nb + 0.075, 0.15 * hw / 0.077, hd + 0.03, hd + 0.06, 0, 0.012, 2.3)]
    rings = [(r[0], r[1], r[2], r[3], r[4], r[5], r[6]) for r in rings]
    top_z = c.z - hh * 0.9 + 0.02
    fall = people.ring_loft((0, c.y, top_z), (0, 0, -1), [
        (0.0, hw + 0.022, hd * 0.62, hd * 0.9 + 0.02),
        (0.06, hw + 0.050, hd * 0.9 + 0.03, hd * 0.9 + 0.05),
        (0.11, hw + 0.085, hd + 0.05, hd + 0.07)], sides=20, side=(1, 0, 0), name=name + "_fall",
        mat=mat, caps=False)
    people.outward(fall)
    for p in fall.data.polygons:
        p.use_smooth = True
    rim(fall, 0.008)
    g1 = fall.vertex_groups.new(name="head")
    g2 = fall.vertex_groups.new(name="neck")
    g3 = fall.vertex_groups.new(name="chest")
    for v in fall.data.vertices:
        t = max(0.0, min(1.0, (top_z - v.co.z) / 0.11))
        g1.add([v.index], 1.0 - t, "REPLACE")
        g2.add([v.index], t * 0.5, "REPLACE")
        g3.add([v.index], t * 0.5, "REPLACE")
    return people.join([h, fall], name)


def coif(P, name="coif", mat="linen"):
    """A close linen cap tied under the chin: face open, hair and ears in."""
    def keep(l):
        a = abs(math.degrees(_theta(l)))
        face = a < 62 and -0.12 < l.z < 0.062
        return not face and l.z > -0.12
    return cap(P, name, keep, lambda l: 0.012, mat=mat, thick=0.004)


def scarf(P):
    """A headscarf: over the crown and ears, knotted at the nape, its tail
    down the back of the neck."""
    s = coif(P, "scarf", mat="cloth2")
    c = people.head_center(P)
    hw, hd, hh = P["head"]
    tail = people.ring_loft(c + V((0, hd * 0.9, -0.07 * hh / 0.118)), (0, 0.25, -1), [
        (0.0, 0.032, 0.016, 0.016), (0.07, 0.042, 0.010, 0.010), (0.11, 0.030, 0.006, 0.006)],
        sides=8, side=(1, 0, 0), name="scarf_tail", mat="cloth2")
    for p in tail.data.polygons:
        p.use_smooth = True
    rig.set_rigid(tail, "head")
    return people.join([s, tail], "scarf")


def _dome(P, name, extra, z_rim, mat="steel", peak=0.0, flat=False):
    """A helmet shell: a dome over the skull from `z_rim` up, `extra` clear
    of it, as its own loft so it is smooth and round whatever the hair is."""
    c = people.head_center(P)
    hw, hd, hh = P["head"]
    k = hh / 0.118
    rings = []
    n = 9
    for i in range(n + 1):
        t = i / n
        phi = t * math.pi / 2
        z = z_rim + (0.125 - z_rim) * math.sin(phi) if not flat else z_rim + (0.125 - z_rim) * t
        r = math.cos(phi) if not flat else (1.0 if t < 0.92 else 0.6)
        rx = (hw + extra) * max(r, 0.02)
        ry = (hd + extra) * max(r, 0.02)
        rings.append((z * k, rx, ry, ry * 1.04, 0, 0, 2.0))
    if peak:
        rings.append((0.125 * k + peak, 0.004, 0.004, 0.004, 0, 0, 2.0))
    o = people.ring_loft(c + V((0, 0.004, 0)), (0, 0, 1), rings, sides=18, side=(-1, 0, 0), name=name,
                         mat=mat)
    for p in o.data.polygons:
        p.use_smooth = True
    rig.set_rigid(o, "head")
    return o


def helm_kettle(P):
    """A kettle hat: a round steel crown with a broad brim all round, the
    town watch's helmet."""
    c = people.head_center(P)
    hw, hd, hh = P["head"]
    crown = _dome(P, "helm_kettle", 0.018, 0.028)
    brim = ring("brim", tuple(c + V((0, 0.004, 0.030 * hh / 0.118))), 1.0, 0.07, mat="steel", seg=20,
                scale=(hw + 0.075, hd + 0.075, 0.06))
    rig.set_rigid(brim, "head")
    return people.join([crown, brim], "helm_kettle")


def helm_nasal(P):
    """A conical helm with a nasal bar."""
    c = people.head_center(P)
    hw, hd, hh = P["head"]
    crown = _dome(P, "helm_nasal", 0.014, 0.018, peak=0.035)
    band = ring("band", tuple(c + V((0, 0.004, 0.022 * hh / 0.118))), 1.0, 0.1, mat="iron", seg=24,
                scale=(hw + 0.016, hd + 0.016, 0.08))
    rig.set_rigid(band, "head")
    nasal = lib.box((0.016, 0.008, 0.07), (0, c.y - hd - 0.020, c.z + 0.002), name="nasal", mat="steel")
    rig.set_rigid(nasal, "head")
    return people.join([crown, band, nasal], "helm_nasal")


def helm_great(P):
    """A great helm: a flat-topped steel pot over the whole head, with the
    sight cut across it and breaths punched below."""
    c = people.head_center(P)
    hw, hd, hh = P["head"]
    k = hh / 0.118
    rings = [(-0.150, hw + 0.020, hd + 0.020, hd + 0.018, 0, 0, 2.6),
             (-0.080, hw + 0.026, hd + 0.030, hd + 0.022, 0, 0, 2.6),
             (0.040, hw + 0.026, hd + 0.032, hd + 0.024, 0, 0, 2.6),
             (0.100, hw + 0.020, hd + 0.024, hd + 0.020, 0, 0, 2.5),
             (0.132, hw + 0.004, hd + 0.006, hd + 0.004, 0, 0, 2.4)]
    rings = [(z * k, a, b, d, e, f, g) for (z, a, b, d, e, f, g) in rings]
    pot = people.ring_loft(c + V((0, 0.006, 0)), (0, 0, 1), rings, sides=24, side=(-1, 0, 0),
                           name="helm_great", mat="steel")
    for p in pot.data.polygons:
        p.use_smooth = True
    rig.set_rigid(pot, "head")
    slit = lib.box((0.13, 0.012, 0.012), (0, c.y - hd - 0.030, c.z + 0.004), name="sight", mat="eye")
    rig.set_rigid(slit, "head")
    cross = lib.box((0.018, 0.010, 0.10), (0, c.y - hd - 0.033, c.z - 0.045), name="cross", mat="iron")
    rig.set_rigid(cross, "head")
    return people.join([pot, slit, cross], "helm_great")


def hat_wizard(P):
    """A tall cone with a soft brim and a crumpled tip."""
    c = people.head_center(P)
    hw, hd, hh = P["head"]
    base = c + V((0, 0.006, 0.050 * hh / 0.118))
    rings = [(0.0, hw + 0.016, hd + 0.016, hd + 0.016), (0.08, hw * 0.7, hd * 0.7, hd * 0.7),
             (0.18, hw * 0.38, hd * 0.38, hd * 0.38), (0.26, 0.012, 0.012, 0.012)]
    cone = people.ring_loft(base, (0, 0.18, 1), rings, sides=16, name="hat_wizard", mat="cloth")
    brim = ring("brim", tuple(base + V((0, 0, -0.004))), 1.0, 0.06, mat="cloth", seg=24,
                scale=(hw + 0.085, hd + 0.085, 0.08))
    for o in (cone,):
        for p in o.data.polygons:
            p.use_smooth = True
    rig.set_rigid(cone, "head")
    rig.set_rigid(brim, "head")
    return people.join([cone, brim], "hat_wizard")


def turban(P):
    """A turban: a cloth dome wound round the head in three turns, the loose
    end hanging behind -- a desert man's, and a dervish's."""
    c = people.head_center(P)
    hw, hd, hh = P["head"]
    k = hh / 0.118
    crown = _dome(P, "turban", 0.034, 0.018, mat="linen")
    for v in crown.data.vertices:
        # Wound high: the cloth stands well above the crown.
        if v.co.z > c.z + 0.06 * k:
            v.co.z += (v.co.z - (c.z + 0.06 * k)) * 0.9
    parts = [crown]
    for i, (z, tilt) in enumerate(((0.028, 8), (0.052, -7), (0.076, 10), (0.098, -5))):
        band = ring("band%d" % i, tuple(c + V((0, 0.006, z * k))), 1.0, 0.20, mat="linen", seg=20,
                    rot=(math.radians(tilt), 0, 0), scale=(hw + 0.040 - i * 0.007, hd + 0.040 - i * 0.007,
                                                         0.11))
        rig.set_rigid(band, "head")
        parts.append(band)
    tail = people.ring_loft(c + V((0.02, hd * 0.95, 0.04 * k)), (0.1, 0.4, -1), [
        (0.0, 0.030, 0.008, 0.008), (0.10, 0.034, 0.006, 0.006), (0.16, 0.026, 0.005, 0.005)],
        sides=8, side=(1, 0, 0), name="turban_tail", mat="linen")
    for pl in tail.data.polygons:
        pl.use_smooth = True
    rig.set_rigid(tail, "head")
    parts.append(tail)
    return people.join(parts, "turban")


def hat_cap(P):
    """A soft felt cap: the everyday hat of a tradesman."""
    return _dome(P, "hat_cap", 0.016, 0.040, mat="cloth2")


HEAD_PIECES = {
    "male": [hair_short, hair_crop, hair_long, hair_fringe, hair_tail, beard_full, beard_short, moustache,
             hood, coif, helm_kettle, helm_nasal, helm_great, hat_wizard, hat_cap, turban,
             hair_swept, hair_undercut, hair_warrior],
    "female": [hair_long, hair_bun, hair_braid, hair_tail, hair_short, scarf, coif, hood,
               helm_kettle, helm_nasal, hat_wizard, hair_ponyhigh, hair_crown, hair_waves],
}
