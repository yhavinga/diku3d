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

def skirt_weights(obj, arm, top, hem, follow=0.5, bones=("hips", "thigh.L", "thigh.R"),
                  above=None):
    """Weights for cloth hanging below the waist: all hips at `top`, sliding
    towards the thigh on its own side by the time it reaches `hem`, but only
    ever `follow` of the way. `above` is an optional function giving weights
    for vertices above `top` (a bodice, a tabard's chest)."""
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    groups = {b: obj.vertex_groups.new(name=b) for b in bones}
    extra = {}
    for v in obj.data.vertices:
        z = v.co.z
        if above and z > top:
            for b, w in above(v.co).items():
                if b not in groups:
                    groups[b] = obj.vertex_groups.new(name=b)
                groups[b].add([v.index], w, "REPLACE")
            continue
        t = max(0.0, min(1.0, (top - z) / max(1e-3, top - hem)))
        t = t * t * (3 - 2 * t) * follow
        side = max(0.0, min(1.0, 0.5 + v.co.x / 0.12))
        groups["hips"].add([v.index], 1.0 - t, "REPLACE")
        groups["thigh.L"].add([v.index], t * side, "REPLACE")
        groups["thigh.R"].add([v.index], t * (1.0 - side), "REPLACE")
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
               ease=0.014, hem_wave=0.0, ragged=0.0, lift_front=0.0, under=()):
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
        if ri > 0:
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

def rigid_shell(body, arm, name, keep, bone, offset=0.02, mat="steel", planes=(), thick=0.008):
    obj = shell(body, arm, name, keep, offset=offset, mat=mat, planes=planes, thick=thick)
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


def cloak(body, arm, C, hem, mat="cloth", under=(), width=0.26, name="cloak", ragged=0.0):
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
            a = math.radians(15 + 150 * c / cols)
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


DRESS = {"brute": brute, "lady": lady, "nomad": nomad, "skeleton": skeleton, "troll": troll, "woman": woman, "maid": maid, "crone": crone, "peasant": peasant, "guard": guard, "merchant": merchant, "smith": smith,
         "priest": priest, "mage": mage, "rogue": rogue, "beggar": beggar, "noble": noble,
         "knight": knight, "zombie": zombie, "ghost": ghost}



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
             hood, coif, helm_kettle, helm_nasal, helm_great, hat_wizard, hat_cap, turban],
    "female": [hair_long, hair_bun, hair_braid, hair_tail, hair_short, scarf, coif, hood,
               helm_kettle, helm_nasal, hat_wizard],
}
