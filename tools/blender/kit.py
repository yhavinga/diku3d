"""Architecture-level helpers on top of lib.py.

lib.py gives primitives; this gives the parts a building is actually made of --
wall panels with holes punched by construction rather than by boolean, gable
roofs with real eaves and a ridge, windows with sills and shutters.

Two decisions drive everything here, both about the triangle budget:

* Openings are the gaps between boxes, never a boolean. A boolean leaves n-gons
  that bevel badly and costs triangles nobody ever sees.
* Anything long and straight is a `timber()`: a chamfered profile extruded, 28
  triangles, versus 44 for the same box under a one-segment bevel modifier. The
  chamfer runs the full length of the member, which is exactly the arris that
  catches the light. The ends are left square because they always butt into
  something else.

Everything is authored with the asset's base centre at the origin: X across,
Y depth, Z up, and the front (the face with the door) at -Y. The glTF exporter
turns that into three's -Z, which the viewer calls north.
"""

import bpy
import bmesh
import math
import mathutils

import lib


# --- placement ------------------------------------------------------------

def at(loc, rot, lx, lz=0.0, ly=0.0):
    """Local (across, up, out) on a wall rotated `rot` about Z -> world.
    Negative `ly` is outward, whichever way the wall faces."""
    c, s = math.cos(rot), math.sin(rot)
    return (loc[0] + c * lx - s * ly, loc[1] + s * lx + c * ly, loc[2] + lz)


def rotate_z(objs, angle):
    """Swing a finished sub-assembly about the world Z axis. Works on the world
    matrix, so it does not care whether a part's rotation was applied or not.

    The update() is not optional: matrix_world is only recomputed when the
    depsgraph runs, so an object created and moved in this same tick still reads
    back as the identity, and rotating that lands it neatly on the origin."""
    bpy.context.view_layer.update()
    R = mathutils.Matrix.Rotation(angle, 4, "Z")
    for obj in objs:
        obj.matrix_world = R @ obj.matrix_world
    return objs


def bev(obj, width=0.02, segments=1, angle=35):
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle)
    mod.harden_normals = False      # needs custom normals; these shade flat
    return obj


# --- the workhorse --------------------------------------------------------

def timber(size, loc=(0, 0, 0), rot=(0, 0, 0), mat="oak", cham=0.035, name="timber"):
    """Box with the four arrises along its longest axis chamfered off.
    28 triangles, and the chamfer is what stops it reading as a box."""
    sx, sy, sz = size
    axis = max(range(3), key=lambda i: size[i])
    length = size[axis]
    a, b = [size[i] for i in range(3) if i != axis]
    c = min(cham, a * 0.34, b * 0.34)
    ha, hb, hl = a / 2, b / 2, length / 2

    ring = [(-ha + c, -hb), (ha - c, -hb), (ha, -hb + c), (ha, hb - c),
            (ha - c, hb), (-ha + c, hb), (-ha, hb - c), (-ha, -hb + c)]
    verts, faces = [], []
    for end in (-hl, hl):
        for (u, v) in ring:
            if axis == 0:
                verts.append((end, u, v))
            elif axis == 1:
                verts.append((u, end, v))
            else:
                verts.append((u, v, end))
    for i in range(8):
        j = (i + 1) % 8
        faces.append((i, j, j + 8, i + 8))
    faces.append(tuple(range(7, -1, -1)))
    faces.append(tuple(range(8, 16)))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = rot
    lib.assign(obj, mat)
    if any(rot):
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    return obj


def slab(size, loc=(0, 0, 0), rot=(0, 0, 0), mat="stonewall", name="slab", width=0.05):
    """A box that wants all twelve edges taken off -- a cap, a plinth course, a
    step. 44 triangles at one segment, so use it where the silhouette shows."""
    obj = lib.box(size, loc, rot, name=name, mat=mat)
    bev(obj, width)
    return obj


# --- walls ----------------------------------------------------------------

def panel(w, h, t, openings=(), mat="timber", loc=(0, 0, 0), rot=0.0, name="panel"):
    """Wall panel: spans `w` across, `h` up from loc.z, `t` thick along its
    normal. `openings` are (centre_x, sill_z, width, height) holes, which must
    not overlap in x. Flat boxes -- the framing laid over the top gives the
    edges, so paying for a bevel here would be paying twice."""
    parts = []
    x = -w / 2
    for (cx, oz, ow, oh) in sorted(openings, key=lambda o: o[0] - o[2] / 2):
        left, right = cx - ow / 2, cx + ow / 2
        if left - x > 1e-4:
            parts.append(((x + left) / 2, h / 2, left - x, h))
        if oz > 1e-4:
            parts.append((cx, oz / 2, ow, oz))
        if h - oz - oh > 1e-4:
            parts.append((cx, (oz + oh + h) / 2, ow, h - oz - oh))
        x = right
    if w / 2 - x > 1e-4:
        parts.append(((x + w / 2) / 2, h / 2, w / 2 - x, h))
    return [lib.box((bw, t, bh), at(loc, rot, cx, cz), (0, 0, rot), name=name, mat=mat)
            for (cx, cz, bw, bh) in parts]


def faces_of(w, d, t, z0):
    """front(-Y), back(+Y), left(-X), right(+X) as (span, loc, rot).

    The rotations are chosen so a panel's local +Y is inward on all four faces,
    which is what makes `at(..., ly)` mean the same thing everywhere. Take the
    obvious rot for left and right and it comes out mirrored, so every sill and
    every shutter on a flank projects into the building instead of out of it --
    invisible from the street, and the reason the flanks looked flat."""
    return {
        "front": (w, (0, -d / 2 + t / 2, z0), 0.0),
        "back": (w, (0, d / 2 - t / 2, z0), math.pi),
        "left": (d - 2 * t, (-w / 2 + t / 2, 0, z0), -math.pi / 2),
        "right": (d - 2 * t, (w / 2 - t / 2, 0, z0), math.pi / 2),
    }


def shell(w, d, h, t, z0=0.0, holes=None, mat="timber", name="wall"):
    holes = holes or {}
    objs = []
    for key, (span, loc, rot) in faces_of(w, d, t, z0).items():
        objs += panel(span, h, t, holes.get(key, ()), mat, loc, rot, "%s_%s" % (name, key))
    return objs


# --- timber framing -------------------------------------------------------

def _spans(w, skip):
    """The x-intervals of a wall a rail can actually run through."""
    free, x = [], -w / 2
    for (lo, hi) in sorted(skip):
        if lo - x > 0.35:
            free.append((x, lo))
        x = max(x, hi)
    if w / 2 - x > 0.35:
        free.append((x, w / 2))
    return free


def framing(w, h, t, loc, rot, posts=3, braces=True, rail=0.0, sill=True,
            size=0.26, mat="oak", skip=(), corner=True, sill_skip=()):
    """Exposed studwork over a panel. `skip` is the x-ranges a door or a window
    band occupies; posts avoid them and rails run only through the gaps. The
    sole plate keeps running under windows, so it takes its own `sill_skip` --
    only a doorway actually breaks it, and a threshold you trip over is worse
    than a missing beam."""
    objs = []
    d = t * 1.45
    if sill:
        for (lo, hi) in _spans(w, sill_skip):
            objs.append(timber((hi - lo, d, size), at(loc, rot, (lo + hi) / 2, size / 2),
                               (0, 0, rot), mat))
    objs.append(timber((w, d, size), at(loc, rot, 0, h - size / 2), (0, 0, rot), mat))
    if rail:
        for (lo, hi) in _spans(w, skip):
            objs.append(timber((hi - lo, d * 0.92, size * 0.8),
                               at(loc, rot, (lo + hi) / 2, rail), (0, 0, rot), mat))
    inner_z, inner_h = size, h - 2 * size
    for i in range(posts):
        px = -w / 2 + w * (i + 1) / (posts + 1)
        if any(lo - size < px < hi + size for (lo, hi) in skip):
            continue
        objs.append(timber((size, d * 0.92, inner_h), at(loc, rot, px, inner_z + inner_h / 2),
                           (0, 0, rot), mat))
    if corner:
        for sx in (-1, 1):
            objs.append(timber((size * 1.3, d * 1.05, h),
                               at(loc, rot, sx * (w / 2 - size * 0.65), h / 2), (0, 0, rot), mat))
    if braces:
        run = min(w * 0.2, (h - 2 * size) * 0.55)
        for sx in (-1, 1):
            cx = sx * (w / 2 - size * 1.3 - run / 2)
            if any(lo - 0.2 < cx < hi + 0.2 for (lo, hi) in skip):
                continue
            objs.append(timber((run * 1.41 + size * 0.7, d * 0.85, size * 0.8),
                               at(loc, rot, cx, size + run / 2),
                               (0, sx * math.pi / 4, rot), mat))
    return objs


def jetty(w, d, z, out, size=0.3, joists=5, mat="oak"):
    """Bressumer beams and the joist ends under an overhanging upper floor."""
    objs = []
    ow, od = w + 2 * out, d + 2 * out
    for (span, loc, rot) in ((ow, (0, -od / 2 + size / 2, z), 0.0),
                             (ow, (0, od / 2 - size / 2, z), 0.0),
                             (od - 2 * size, (-ow / 2 + size / 2, 0, z), math.pi / 2),
                             (od - 2 * size, (ow / 2 - size / 2, 0, z), math.pi / 2)):
        objs.append(timber((span, size, size * 1.3), (loc[0], loc[1], loc[2] + size * 0.65),
                           (0, 0, rot), mat, 0.05))
    for i in range(joists):
        fx = -w / 2 + w * (i + 0.5) / joists
        for sy in (-1, 1):
            objs.append(timber((size * 0.5, out * 1.1, size * 0.5),
                               (fx, sy * (d / 2 + out * 0.45), z + size * 0.3), (0, 0, 0), mat, 0.02))
    return objs


# --- openings -------------------------------------------------------------

def window(cx, cz, ow, oh, loc, rot, t, mat="oak", glass=True, shutters=False,
           mullions=1, sill_out=0.15, sill_mat=None):
    """Frame, projecting sill, glazing bar, and shutters folded flat on the
    wall. Fills the hole a panel() left; sizes are that hole's."""
    objs = []
    j = 0.1
    d = t * 1.6
    # Jambs, head and glazing bar are plain boxes: at 100 mm section the chamfer
    # on a timber() is invisible and costs more than twice the triangles. The
    # sill is the one member that projects into the light, so it keeps its.
    objs.append(lib.box((j, d, oh), at(loc, rot, cx - ow / 2 + j / 2, cz + oh / 2),
                        (0, 0, rot), name="jamb", mat=mat))
    objs.append(lib.box((j, d, oh), at(loc, rot, cx + ow / 2 - j / 2, cz + oh / 2),
                        (0, 0, rot), name="jamb", mat=mat))
    objs.append(lib.box((ow, d, j * 1.2), at(loc, rot, cx, cz + oh - j * 0.6),
                        (0, 0, rot), name="head", mat=mat))
    objs.append(timber((ow + 0.3, d + sill_out, 0.12),
                       at(loc, rot, cx, cz + 0.03, -sill_out / 2), (0, 0, rot),
                       sill_mat or mat, 0.03))
    for i in range(mullions):
        mx = cx - ow / 2 + ow * (i + 1) / (mullions + 1)
        objs.append(lib.box((0.075, d * 0.9, oh - j), at(loc, rot, mx, cz + (oh - j) / 2),
                            (0, 0, rot), name="mullion", mat=mat))
    if glass:
        objs.append(lib.box((ow - 2 * j, 0.03, oh - j * 1.8),
                            at(loc, rot, cx, cz + (oh - j * 0.8) / 2, t * 0.3),
                            (0, 0, rot), name="pane", mat="glass"))
    if shutters:
        for sx in (-1, 1):
            objs.append(timber((ow * 0.48, 0.07, oh * 0.9),
                               at(loc, rot, cx + sx * (ow * 0.75), cz + oh / 2, -t * 0.9 - 0.05),
                               (0, 0, rot), "planks", 0.02))
    return objs


def door(cx, ow, oh, loc, rot, t, mat="planks", frame="oak", boards=5, arch=False):
    """A plank door in a heavy frame, set back in its reveal."""
    objs = []
    j = 0.18
    d = t * 1.8
    objs.append(timber((j, d, oh + 0.3), at(loc, rot, cx - ow / 2 + j / 2, (oh + 0.3) / 2), (0, 0, rot), frame))
    objs.append(timber((j, d, oh + 0.3), at(loc, rot, cx + ow / 2 - j / 2, (oh + 0.3) / 2), (0, 0, rot), frame))
    objs.append(timber((ow + 0.36, d, 0.34), at(loc, rot, cx, oh + 0.17), (0, 0, rot), frame, 0.05))
    leaf = (ow - 2 * j) / boards
    for i in range(boards):
        bx = cx - ow / 2 + j + leaf * (i + 0.5)
        objs.append(timber((leaf * 0.93, 0.1, oh - 0.05),
                           at(loc, rot, bx, (oh - 0.05) / 2, t * 0.4), (0, 0, rot), mat, 0.018))
    for hz in (oh * 0.2, oh * 0.76):
        objs.append(timber((ow - 2 * j - 0.08, 0.06, 0.15),
                           at(loc, rot, cx, hz, t * 0.4 - 0.08), (0, 0, rot), "iron", 0.015))
    if arch:
        objs.append(timber((ow + 0.5, d, 0.3), at(loc, rot, cx, oh + 0.5), (0, 0, rot), frame, 0.05))
    return objs


# --- roofs ----------------------------------------------------------------

def gable_roof(span, length, height, z0, thick=0.24, eave=0.5, verge=0.4,
               mat="rooftile", trim="oak", tympanum="timber", half_hip=0.0,
               along="x", barge=True, fascia=True):
    """Two pitched planes, a ridge, barge boards, eaves fascia and the gable
    wall behind. `span` is across the ridge, `length` along it; along='y' turns
    the whole thing a quarter so the gable faces the street."""
    objs = []
    half = span / 2
    pitch = math.atan2(height, half)
    run = half + eave
    drop = height * eave / half
    L = run / math.cos(pitch)
    total = length + 2 * verge
    zc = z0 + height - height * run / (2 * half)
    lift = thick / (2 * math.cos(pitch))

    for sy in (-1, 1):
        # A plane's local +Y climbs towards the ridge on the -Y side and falls
        # away from it on the +Y side, so the pitch is -sy, not sy. Getting this
        # backwards builds a valley and looks, from above, entirely plausible.
        objs.append(timber((total, L, thick), (0, sy * run / 2, zc + lift),
                           (-sy * pitch, 0, 0), mat, 0.05, "roof"))
        if barge:
            for sx in (-1, 1):
                objs.append(timber((0.11, L, 0.3), (sx * total / 2, sy * run / 2, zc + lift - 0.11),
                                   (-sy * pitch, 0, 0), trim, 0.025, "barge"))
        if fascia:
            objs.append(timber((total, 0.13, 0.32), (0, sy * run, z0 - drop + 0.06),
                               (0, 0, 0), trim, 0.025, "fascia"))

    objs.append(timber((total + 0.08, 0.44, 0.32), (0, 0, z0 + height + 0.06),
                       (0, 0, 0), mat, 0.08, "ridge"))

    if tympanum:
        for sx in (-1, 1):
            objs.append(lib.wedge(span, height, 0.26, (sx * (length / 2 - 0.13), 0, z0),
                                  (0, 0, math.pi / 2), name="gable_wall", mat=tympanum))
    if half_hip > 0:
        for sx in (-1, 1):
            objs.append(timber((0.34, span * 0.55, half_hip * 1.3),
                               (sx * (total / 2 - 0.17), 0, z0 + height - half_hip * 0.5),
                               (0, sx * -pitch * 0.8, 0), mat, 0.05, "hip"))
    if along == "y":
        rotate_z(objs, math.pi / 2)
    return objs


def gable_frame(span, height, z0, x, size=0.24, mat="oak", collar=0.45, along="x"):
    """Tie beam and king post across a gable end. Without these the tympanum is
    a blank triangle of plaster, which is the one part of a timber-framed house
    that has to look framed."""
    # King post stands on the collar, not through it -- everything below the
    # collar has to stay clear for a loading door or an attic window.
    zc = z0 + height * collar
    post_h = height * (0.92 - collar)
    objs = [timber((size * 1.15, span * (1 - collar), size), (x, 0, zc), (0, 0, 0), mat),
            timber((size * 1.15, size, post_h), (x, 0, zc + post_h / 2), (0, 0, 0), mat)]
    if along == "y":
        rotate_z(objs, math.pi / 2)
    return objs


def crow_gable(span, height, z0, offset, steps=7, thick=0.5, mat="stonewall",
               along="x"):
    """A crow-stepped gable: the wall carried up past the roof as a staircase.
    A stack of boxes each narrower than the one below draws that profile for
    free, and it wants gable_roof(verge=0, barge=False, tympanum=None) behind it
    -- the wall is the edge of the roof, there is no overhang to trim."""
    # Built for a ridge along X, so the wall lies across Y at x = offset.
    objs = []
    rise = height / steps
    for i in range(steps):
        w = span * (1.0 - i / float(steps)) + 0.35
        objs.append(timber((thick, w, rise * 1.02), (offset, 0, z0 + rise * (i + 0.5)),
                           (0, 0, 0), mat, 0.055, "crowstep"))
    objs.append(timber((thick + 0.14, span * 0.16 + 0.4, 0.34),
                       (offset, 0, z0 + height + 0.17), (0, 0, 0), mat, 0.06, "gable_cap"))
    if along == "y":
        rotate_z(objs, math.pi / 2)
    return objs


def hip_roof(w, d, height, z0, thick=0.24, eave=0.5, mat="rooftile", trim="oak"):
    """Four planes meeting at a short ridge. Cheap version: four wedges as
    triangular planes plus a ridge."""
    objs = []
    ow, od = w + 2 * eave, d + 2 * eave
    ridge_len = max(ow - od, 0.6)
    for (sx, sy, span, length, rot) in ((0, -1, od, ow, 0.0), (0, 1, od, ow, math.pi),
                                        (-1, 0, ow, od, math.pi / 2), (1, 0, ow, od, -math.pi / 2)):
        pitch = math.atan2(height, span / 2)
        L = (span / 2) / math.cos(pitch)
        objs.append(timber((length, L, thick),
                           (sx * (ow / 2 - ow / 4) if sx else 0,
                            sy * (od / 2 - od / 4) if sy else 0,
                            z0 + height / 2 + thick * 0.5),
                           (pitch if sy == -1 else (-pitch if sy == 1 else 0),
                            0, 0), mat, 0.05, "hip_plane"))
        if sx:
            objs[-1].rotation_euler = mathutils.Euler((pitch, 0, rot), "XYZ")
            bpy.ops.object.select_all(action="DESELECT")
            objs[-1].select_set(True)
            bpy.context.view_layer.objects.active = objs[-1]
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    objs.append(timber((ridge_len, 0.44, 0.32), (0, 0, z0 + height + 0.06), (0, 0, 0),
                       mat, 0.08, "ridge"))
    for (loc, rot, span) in (((0, -od / 2, z0 + 0.06), 0.0, ow), ((0, od / 2, z0 + 0.06), 0.0, ow),
                             ((-ow / 2, 0, z0 + 0.06), math.pi / 2, od), ((ow / 2, 0, z0 + 0.06), math.pi / 2, od)):
        objs.append(timber((span, 0.13, 0.32), loc, (0, 0, rot), trim, 0.025, "fascia"))
    return objs


def chimney(x, y, z0, top, w=1.0, mat="stonewall", pots=2, pot_mat="rooftile"):
    objs = [timber((w, w, top - z0), (x, y, (z0 + top) / 2), (0, 0, 0), mat, 0.06, "stack"),
            slab((w + 0.32, w + 0.32, 0.24), (x, y, top + 0.12), mat=mat, name="cap", width=0.05)]
    for i in range(pots):
        px = x + (i - (pots - 1) / 2) * w * 0.44
        pot = lib.cylinder(w * 0.15, 0.62, (px, y, top + 0.5), verts=6, name="pot", mat=pot_mat)
        objs.append(pot)
    return objs


def steps(w, depth, rise, count, z0=0.0, y0=0.0, mat="marble", inset=0.0):
    """Broad steps climbing in +Y; the bottom tread's outer edge sits at y0."""
    objs = []
    tread = depth / count
    for i in range(count):
        h = rise * (i + 1)
        objs.append(slab((w - i * inset * 2, tread * (count - i), h),
                         (0, y0 + tread * i + tread * (count - i) / 2, z0 + h / 2),
                         mat=mat, name="step", width=0.04))
    return objs


def fluted_shaft(r0, r1, height, z0, x=0.0, y=0.0, flutes=10, depth=0.06,
                 mat="marble", name="shaft"):
    """Column shaft whose section is a ring of alternating radii, so the
    silhouette is faintly toothed and the light breaks into vertical stripes.
    Flat-shaded on purpose: smoothing it averages the flutes back into a
    cylinder and the whole point is lost."""
    n = flutes * 2
    verts, faces = [], []
    for (r, z) in ((r0, z0), (r1, z0 + height)):
        for i in range(n):
            a = 2 * math.pi * i / n
            rr = r - (depth if i % 2 else 0.0)
            verts.append((x + rr * math.cos(a), y + rr * math.sin(a), z))
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, j + n, i + n))
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return lib.assign(obj, mat)


def column(x, y, z0, height, radius=0.52, flutes=10, mat="marble", taper=0.87):
    """Base, fluted shaft, echinus and abacus. Doric enough at twenty metres,
    and at two metres the flutes are what stop it being a pipe."""
    base_h, cap_h, ab_h = 0.28, 0.26, 0.22
    shaft_h = height - base_h - cap_h - ab_h
    z = z0 + base_h
    return [
        timber((radius * 2.5, radius * 2.5, base_h), (x, y, z0 + base_h / 2),
               (0, 0, 0), mat, 0.05, "col_base"),
        fluted_shaft(radius, radius * taper, shaft_h, z, x, y, flutes, mat=mat),
        lib.cone(radius * taper * 1.42, radius * taper, cap_h,
                 (x, y, z + shaft_h + cap_h / 2), verts=flutes * 2, name="echinus", mat=mat),
        timber((radius * 2.7, radius * 2.7, ab_h), (x, y, z + shaft_h + cap_h + ab_h / 2),
               (0, 0, 0), mat, 0.04, "abacus"),
    ]


def pediment(span, height, depth, z0, offset, thick=0.34, mat="marble",
             trim="marble", along="x"):
    """Tympanum, the raking cornice over it and the horizontal cornice under.
    Built for a ridge along X with the gable at x = offset."""
    objs = [lib.wedge(span, height, depth, (offset, 0, z0), (0, 0, math.pi / 2),
                      name="tympanum", mat=mat)]
    pitch = math.atan2(height, span / 2)
    L = (span / 2) / math.cos(pitch) + 0.28
    for sy in (-1, 1):
        objs.append(timber((depth + 0.5, L, thick),
                           (offset, sy * span / 4, z0 + height / 2 + thick * 0.62),
                           (-sy * pitch, 0, 0), trim, 0.05, "raking_cornice"))
    objs.append(timber((depth + 0.5, span + 0.6, thick), (offset, 0, z0 - thick / 2),
                       (0, 0, 0), trim, 0.05, "cornice"))
    if along == "y":
        rotate_z(objs, math.pi / 2)
    return objs


# --- output ---------------------------------------------------------------

def zero_origin(obj):
    """Bake the object transform into the mesh so the exported glTF node is the
    identity and the vertex coordinates really are asset space.

    join() hands the result the transform of whichever part happened to be
    first, so without this the barrel is fine and the stone arch is offset by
    1.88 m -- correct if you instantiate the node hierarchy, and quietly wrong
    for anything that reads the geometry straight out, which is exactly what
    build.js's Batcher does."""
    bpy.context.view_layer.update()
    obj.data.transform(obj.matrix_world)
    obj.matrix_world = mathutils.Matrix.Identity(4)
    obj.data.update()
    return obj


def deliver(parts, name):
    """Apply, join, re-origin, unwrap, export -- and say what it cost."""
    parts = [p for p in parts if p is not None]
    for obj in parts:
        lib.apply_modifiers(obj)
    obj = lib.join(parts, name)
    zero_origin(obj)
    obj.data.name = name
    lib.uv_project(obj)
    tris = lib.stats([obj])
    lib.export(name, [obj])
    return "%-16s %5d tris" % (name, tris)


# --- looking at it --------------------------------------------------------

def human(x=0.0, y=-8.0):
    """A 1.75 m figure to check proportions against. Never exported."""
    objs = [lib.box((0.44, 0.25, 0.62), (x, y, 1.14), name="ref_torso", mat="cloth"),
            lib.box((0.36, 0.23, 0.5), (x, y, 0.58), name="ref_hips", mat="cloth"),
            lib.cylinder(0.1, 0.86, (x - 0.11, y, 0.43), verts=8, name="ref_leg", mat="cloth"),
            lib.cylinder(0.1, 0.86, (x + 0.11, y, 0.43), verts=8, name="ref_leg", mat="cloth"),
            lib.sphere(0.12, (x, y, 1.62), 10, 7, name="ref_head", mat="skin")]
    return lib.join(objs, "REF_human")


def look(center=(0, 0, 4), dist=30.0, azim=40.0, elev=16.0, shading="MATERIAL"):
    for area in bpy.context.screen.areas:
        if area.type != "VIEW_3D":
            continue
        sp = area.spaces[0]
        sp.region_3d.view_perspective = "PERSP"
        sp.region_3d.view_location = mathutils.Vector(center)
        sp.region_3d.view_distance = dist
        sp.region_3d.view_rotation = mathutils.Euler(
            (math.radians(90.0 - elev), 0.0, math.radians(azim)), "XYZ").to_quaternion()
        sp.shading.type = shading
        sp.overlay.show_floor = True
        sp.overlay.show_axis_x = False
        sp.overlay.show_axis_y = False
        sp.overlay.show_cursor = False
        sp.overlay.show_text = False
        sp.overlay.show_object_origins = False
        sp.overlay.show_relationship_lines = False
        area.tag_redraw()
    return "view set"
