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


def place(objs, loc=(0, 0, 0), rot=(0, 0, 0)):
    """Move and turn a finished sub-assembly bodily, through the world matrix.

    The alternative -- reassigning each part's rotation_euler -- silently throws
    away whatever rotation it was built with, which is how a wheel's spokes all
    ended up parallel."""
    bpy.context.view_layer.update()
    M = (mathutils.Matrix.Translation(loc) @
         mathutils.Euler(rot, "XYZ").to_matrix().to_4x4())
    for obj in objs:
        obj.matrix_world = M @ obj.matrix_world
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
    # 85 mm proud of the infill on each face. The old 1.45 * t left the studwork
    # barely 50 mm out and at a low sun it cast nothing; this is the difference
    # between a frame drawn on a wall and a frame standing on one.
    d = t + 0.17
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


def jetty(w, d, z, out, size=0.32, joists=5, mat="oak", band=0.34, braces=3,
          soffit=True):
    """An overhanging upper floor built the way one is: joists cantilevered out
    over the storey below, a bressumer laid on their ends, and curved corbel
    braces from the wall up under it.

    `out` wants to be 0.7 m or more. At 0.3 m the oversail is a moulding; at
    0.8 m it is a roof over the pavement, the whole ground storey sits in its
    shade, and the braces under it are the small isolated shadows that say the
    building was assembled rather than extruded."""
    objs = []
    ow, od = w + 2 * out, d + 2 * out
    zb = z + band / 2 - 0.01
    if soffit:
        objs.append(lib.box((ow - 0.1, od - 0.1, 0.09), (0, 0, z + band - 0.05),
                            name="soffit", mat="planks"))
    for (span, loc, rot) in ((ow, (0, -od / 2 + size / 2, 0), 0.0),
                             (ow, (0, od / 2 - size / 2, 0), 0.0),
                             (od - 2 * size, (-ow / 2 + size / 2, 0, 0), math.pi / 2),
                             (od - 2 * size, (ow / 2 - size / 2, 0, 0), math.pi / 2)):
        objs.append(timber((span, size, band + 0.1), (loc[0], loc[1], zb),
                           (0, 0, rot), mat, 0.05, "bressumer"))
        # A fillet under the bressumer, stepped back: two lines instead of one,
        # which is what a moulded beam reads as from the street.
        objs.append(timber((span - 0.12, size * 0.62, 0.11),
                           (loc[0] * 0.82, loc[1] * 0.82, z - 0.08),
                           (0, 0, rot), mat, 0.025, "fillet"))
    for i in range(joists):
        fx = -w / 2 + w * (i + 0.5) / joists
        run = out - size + 0.34
        for sy in (-1, 1):
            objs.append(timber((size * 0.46, run, 0.26),
                               (fx, sy * (d / 2 + (out - size) / 2 - 0.09), z - 0.15),
                               (0, 0, 0), mat, 0.02, "joist"))
            objs.append(timber((run, size * 0.46, 0.26),
                               (sy * (d / 2 + (out - size) / 2 - 0.09), fx, z - 0.15),
                               (0, 0, 0), mat, 0.02, "joist"))
    # Corbel braces. `braces` is either a count spread across the wall or the
    # explicit x positions to use -- which is what you want as soon as there are
    # windows below, because a brace landing on a window head is worse than no
    # brace at all.
    xs = braces if hasattr(braces, "__len__") else \
        [-w / 2 + w * (i + 0.5) / braces for i in range(braces)]
    run = min(out * 0.95, 0.62)
    for bx in xs:
        for sy in (-1, 1):
            objs.append(timber((0.2, run * 1.5, 0.3),
                               (bx, sy * (d / 2 + out * 0.45), z - run * 0.72),
                               (sy * math.radians(45), 0, 0), mat, 0.03, "corbel"))
            objs.append(timber((run * 1.5, 0.2, 0.3),
                               (sy * (d / 2 + out * 0.45), bx, z - run * 0.72),
                               (0, -sy * math.radians(45), 0), mat, 0.03, "corbel"))
    return objs


def plinth(w, d, z0=0.0, height=0.5, proud=0.085, mat="stonewall", splay=True):
    """The base course the wall stands on: 60-100 mm proud, with a chamfered
    set-off on top so the rain is thrown clear.

    A wall that runs straight into the ground has nothing at the bottom of it
    and reads as pushed into the pavement. The set-off is the cheap half of
    this -- it is the piece that catches the sun and puts a hard line right
    round the building at knee height."""
    objs = [slab((w + 2 * proud, d + 2 * proud, height), (0, 0, z0 + height / 2),
                 mat=mat, name="plinth", width=0.05)]
    if splay:
        s = proud * 0.55
        objs.append(slab((w + 2 * s, d + 2 * s, 0.16), (0, 0, z0 + height + 0.07),
                         mat=mat, name="set_off", width=0.055))
    return objs


def string_course(w, d, z, proud=0.22, height=0.24, mat="stonewall",
                  sides=("front", "back", "left", "right"), mould=True, bury=0.2):
    """A moulding carried round the building at a floor line, standing exactly
    `proud` of the wall face. Two members, the lower one narrower, because one
    flat band reads as a stripe and two read as a cornice."""
    objs = []
    depth = proud + bury
    off = depth / 2.0 - proud                       # centre offset from the face
    m_depth = depth * 0.7
    m_off = m_depth / 2.0 - proud * 0.55            # the fillet stands further back
    span_w, span_d = w + 2 * proud + 0.1, d + 2 * proud + 0.1
    place = {"front": (0, -1, 0.0, span_w), "back": (0, 1, 0.0, span_w),
             "left": (-1, 0, math.pi / 2, span_d), "right": (1, 0, math.pi / 2, span_d)}
    for key in sides:
        (ux, uy, rot, span) = place[key]
        loc = (ux * (w / 2 - off), uy * (d / 2 - off), z)
        objs.append(timber((span, depth, height), loc, (0, 0, rot), mat, 0.05, "course"))
        if mould:
            objs.append(timber((span - 0.18, m_depth, 0.11),
                               (ux * (w / 2 - m_off), uy * (d / 2 - m_off),
                                z - height / 2 - 0.055),
                               (0, 0, rot), mat, 0.025, "course_mould"))
    return objs


def bracket(loc, rot=0.0, reach=0.72, z=0.0, mat="iron", ring=True, name="bracket"):
    """An arm, its diagonal stay and a ring on the end, bolted to a wall.

    `loc` is a point on the *outer face* of the wall, the same rule the wall
    props follow, and everything reaches out into -ly from there.

    Nothing else in the library costs 100 triangles and does as much: it is the
    one thing on a facade small enough to cast a shadow you can read as a
    separate object, and a wall with one of these on it stops being a surface
    and starts being somebody's house."""
    objs = [timber((0.22, 0.14, 0.34), at(loc, rot, 0, z, -0.02), (0, 0, rot), mat, 0.02, name),
            timber((0.09, reach, 0.11), at(loc, rot, 0, z + 0.12, -reach / 2), (0, 0, rot), mat, 0.02, name),
            timber((0.07, reach * 0.85, 0.07),
                   at(loc, rot, 0, z - 0.14, -reach * 0.36), (math.radians(38), 0, rot), mat, 0.015, name)]
    if ring:
        objs.append(lib.cylinder(0.075, 0.035, at(loc, rot, 0, z + 0.02, -reach + 0.06),
                                 (math.pi / 2, 0, rot), verts=8, name=name, mat=mat))
    return objs


def beam_end(loc, rot=0.0, z=0.0, out=0.5, size=0.24, mat="oak", peg=True):
    """A structural member left sticking out of the wall, chamfered and stopped.
    Half of what a timber-framed street is made of is these. `loc` is on the
    outer wall face, as for bracket()."""
    objs = [timber((size, out + 0.2, size * 1.15), at(loc, rot, 0, z, -out / 2 + 0.1),
                   (0, 0, rot), mat, 0.035, "beam_end")]
    if peg:
        objs.append(lib.cylinder(0.045, size * 1.4, at(loc, rot, 0, z, -out + 0.16),
                                 (0, 0, rot), verts=6, name="peg", mat=mat))
    return objs


# --- openings -------------------------------------------------------------

def window(cx, cz, ow, oh, loc, rot, t, mat="oak", glass=True, shutters=False,
           mullions=1, sill_out=0.2, sill_mat=None, proud=0.085, surround=True,
           frame_d=0.12, ledges=True, hood=False):
    """A hole with depth in it.

    The first version of this filled the opening flush with the wall, and the
    whole facade read as printed on. Four things fix that and every one of them
    is geometry, because at a low sun a texture casts nothing:

    * a dressing standing `proud` of the wall all round the opening,
    * the casement pushed back to the *inside* face, so the reveal from the
      dressing to the glass is t - frame_d + proud, never under 150 mm,
    * a sill that oversails the dressing by at least 40 mm with a drip mould
      hung under its front lip, which is the line you see under every window in
      a photograph of a real street,
    * shutters hung 50 mm clear of the dressing so they cast their own edge
      across it rather than lying on it.

    Sizes are the hole's, as left by panel(). Local +Y is into the building on
    every face, so -ly is always outward -- see faces_of().
    """
    objs = []
    hw = ow / 2.0
    face = -t / 2.0                                 # outer face of the wall
    frame_d = min(frame_d, max(0.055, t - 0.10))    # keep the reveal on thin walls
    y_frame = t / 2.0 - frame_d / 2.0               # casement, flush inside
    y_glass = t / 2.0 - frame_d + 0.055

    if surround:
        d_sur = proud + t * 0.55
        y_sur = face - proud + d_sur / 2.0
        jw = 0.17
        for sx in (-1, 1):
            objs.append(timber((jw, d_sur, oh + 0.2),
                               at(loc, rot, cx + sx * (hw + jw / 2 - 0.04),
                                  cz + oh / 2 + 0.06, y_sur),
                               (0, 0, rot), mat, 0.03, "dressing"))
        objs.append(timber((ow + 0.44, d_sur, 0.2),
                           at(loc, rot, cx, cz + oh + 0.06, y_sur),
                           (0, 0, rot), mat, 0.03, "lintel"))

    j = 0.09
    for sx in (-1, 1):
        objs.append(lib.box((j, frame_d, oh), at(loc, rot, cx + sx * (hw - j / 2),
                                                 cz + oh / 2, y_frame),
                            (0, 0, rot), name="jamb", mat=mat))
    objs.append(lib.box((ow, frame_d, 0.1), at(loc, rot, cx, cz + oh - 0.05, y_frame),
                        (0, 0, rot), name="head", mat=mat))
    for i in range(mullions):
        mx = cx - hw + ow * (i + 1) / (mullions + 1)
        objs.append(lib.box((0.075, frame_d * 0.92, oh - j), at(loc, rot, mx, cz + (oh - j) / 2,
                                                                y_frame),
                            (0, 0, rot), name="mullion", mat=mat))
    if glass:
        objs.append(lib.box((ow - 2 * j, 0.03, oh - j * 1.8),
                            at(loc, rot, cx, cz + (oh - j * 0.8) / 2, y_glass),
                            (0, 0, rot), name="pane", mat="glass"))

    sill_out = max(sill_out, proud + 0.055)
    objs.append(timber((ow + 0.5, t + sill_out, 0.13),
                       at(loc, rot, cx, cz + 0.02, -sill_out / 2), (0, 0, rot),
                       sill_mat or mat, 0.03, "sill"))
    objs.append(lib.box((ow + 0.5, 0.06, 0.075),
                        at(loc, rot, cx, cz - 0.085, face - sill_out + 0.03),
                        (0, 0, rot), name="drip", mat=sill_mat or mat))

    if hood:
        objs.append(timber((ow + 0.72, 0.46, 0.15),
                           at(loc, rot, cx, cz + oh + 0.34, face - 0.19),
                           (math.radians(-20), 0, rot), "rooftile", 0.03, "hood"))
        for sx in (-1, 1):
            objs.append(timber((0.12, 0.42, 0.34),
                               at(loc, rot, cx + sx * (hw + 0.16), cz + oh + 0.1, face - 0.16),
                               (math.radians(34), 0, rot), mat, 0.025, "hood_corbel"))

    if shutters:
        lw, y_leaf = ow * 0.5, face - proud - 0.08
        for sx in (-1, 1):
            objs.append(timber((lw, 0.06, oh + 0.1),
                               at(loc, rot, cx + sx * (hw + lw / 2 + 0.06), cz + oh / 2, y_leaf),
                               (0, 0, rot), "planks", 0.02, "shutter"))
            if ledges:
                for lz in (oh * 0.22, oh * 0.8):
                    objs.append(lib.box((lw + 0.04, 0.05, 0.11),
                                        at(loc, rot, cx + sx * (hw + lw / 2 + 0.06),
                                           cz + lz, y_leaf - 0.055),
                                        (0, 0, rot), name="ledge", mat="oak"))
    return objs


def door(cx, ow, oh, loc, rot, t, mat="planks", frame="oak", boards=5, arch=False,
         step=True, proud=0.1, z0=0.0):
    """A plank door in a heavy surround, set back in its reveal, with a lintel
    over it and a threshold you step up onto.

    The leaf sits on the inside face and the surround stands `proud` of the
    wall, so there is a good 250 mm of reveal for the sun to cut across. The
    threshold is the piece that matters most from twenty metres: it is the only
    horizontal in the lower facade, and its shadow is what stops the wall
    looking as if it had been pushed into the pavement."""
    objs = []
    j = 0.2
    d = t * 0.6 + proud
    face = -t / 2.0
    y_sur = face - proud + d / 2.0
    y_leaf = t / 2.0 - 0.09
    for sx in (-1, 1):
        objs.append(timber((j, d, oh + 0.36), at(loc, rot, cx + sx * (ow / 2 - j / 2 + 0.06),
                                                 z0 + (oh + 0.36) / 2, y_sur),
                           (0, 0, rot), frame))
    objs.append(timber((ow + 0.5, d + 0.06, 0.36), at(loc, rot, cx, z0 + oh + 0.18, y_sur - 0.03),
                       (0, 0, rot), frame, 0.05, "lintel"))
    leaf = (ow - 2 * j) / boards
    for i in range(boards):
        bx = cx - ow / 2 + j + leaf * (i + 0.5)
        objs.append(timber((leaf * 0.93, 0.1, oh - 0.05),
                           at(loc, rot, bx, z0 + (oh - 0.05) / 2, y_leaf), (0, 0, rot), mat, 0.018))
    for hz in (oh * 0.2, oh * 0.76):
        objs.append(timber((ow - 2 * j - 0.08, 0.06, 0.15),
                           at(loc, rot, cx, z0 + hz, y_leaf - 0.08), (0, 0, rot), "iron", 0.015))
    if arch:
        objs.append(timber((ow + 0.86, d + 0.12, 0.3), at(loc, rot, cx, z0 + oh + 0.51, y_sur - 0.06),
                           (0, 0, rot), frame, 0.05, "hood"))
        for sx in (-1, 1):
            objs.append(timber((0.24, d + 0.1, 0.44),
                               at(loc, rot, cx + sx * (ow / 2 + 0.28), z0 + oh + 0.14, y_sur - 0.05),
                               (0, 0, rot), frame, 0.04, "corbel"))
    if step:
        objs.append(slab((ow + 0.7, t + 0.78, 0.15), at(loc, rot, cx, z0 + 0.075, -0.39),
                         (0, 0, rot), mat=frame, name="threshold", width=0.035))
        objs.append(slab((ow + 1.06, t + 1.16, 0.14), at(loc, rot, cx, z0 - 0.07, -0.58),
                         (0, 0, rot), mat=frame, name="step", width=0.035))
    return objs


# --- roofs ----------------------------------------------------------------

def gable_roof(span, length, height, z0, thick=0.24, eave=0.55, verge=0.55,
               mat="rooftile", trim="oak", tympanum="timber", half_hip=0.0,
               along="x", barge=True, fascia=True, rafters=8, caps=9, gutter=False):
    """Two pitched planes, a ridge, barge boards, eaves fascia, exposed rafter
    tails and the gable wall behind. `span` is across the ridge, `length` along
    it; along='y' turns the whole thing a quarter so the gable faces the street.

    The eave is what the review was really complaining about. A roof that stops
    at the wall plane has no soffit to be dark and nothing to cast; an eave of
    550 mm with rafter tails under it gives a band of shade the full width of
    the house plus eight little shadows inside it, and that band is the single
    strongest line on the whole building."""
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
                objs.append(timber((0.13, L, 0.36), (sx * (total / 2 + 0.03), sy * run / 2,
                                                     zc + lift - 0.14),
                                   (-sy * pitch, 0, 0), trim, 0.03, "verge_board"))
        if fascia:
            objs.append(timber((total, 0.14, 0.34), (0, sy * (run + 0.07), z0 - drop + 0.04),
                               (0, 0, 0), trim, 0.03, "fascia"))
        if gutter:
            objs.append(timber((total - 0.1, 0.16, 0.16), (0, sy * (run + 0.2), z0 - drop + 0.14),
                               (0, 0, 0), "iron", 0.05, "gutter"))
        # Rafter tails. They have to come out past the fascia and hang below the
        # soffit, or the fascia swallows them and the eave is one bar again --
        # which is exactly what the first attempt at this looked like.
        for i in range(rafters):
            rx = -length / 2 + length * (i + 0.5) / rafters
            ry = half + eave / 2 + 0.09
            rz = z0 - (ry - half) * math.tan(pitch) - 0.19 / math.cos(pitch)
            objs.append(timber((0.11, (eave + 0.56) / math.cos(pitch), 0.2),
                               (rx, sy * ry, rz), (-sy * pitch, 0, 0), trim, 0.02, "rafter"))

    objs.append(timber((total + 0.08, 0.44, 0.3), (0, 0, z0 + height + 0.06),
                       (0, 0, 0), mat, 0.08, "ridge"))
    # Half-round ridge tiles, faked as short blocks with a wide chamfer. They
    # break the ridge line into something with a rhythm instead of one long bar.
    for i in range(caps):
        objs.append(timber((total / caps * 0.9, 0.5, 0.2),
                           (-total / 2 + total * (i + 0.5) / caps, 0, z0 + height + 0.28),
                           (0, 0, 0), mat, 0.09, "ridge_cap"))

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


def rake(azim=68.0, elev=10.0, strength=5.0, fill=0.06):
    """A sun ten degrees above the horizon, raking along the front of the
    building, plus a ground plane for it to fall on.

    This is the only test that says whether a facade has relief in it or paint
    on it: at this angle a real cornice, sill or shutter draws a hard black line
    across the wall under it, and a texture draws nothing at all. `azim` 0 puts
    the sun straight down the -Y axis behind the viewer, which flattens
    everything; 68 puts it round to the left so the front is grazed."""
    for obj in list(bpy.data.objects):
        if obj.name.startswith("RAKE_"):
            bpy.data.objects.remove(obj, do_unlink=True)
    sun_data = bpy.data.lights.new("RAKE_sun", type="SUN")
    sun_data.energy = strength
    sun_data.angle = math.radians(1.6)          # near-parallel: hard edges
    sun = bpy.data.objects.new("RAKE_sun", sun_data)
    bpy.context.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(90.0 - elev), 0.0, math.radians(azim))

    bpy.ops.mesh.primitive_plane_add(size=120, location=(0, 0, -0.01))
    ground = bpy.context.object
    ground.name = "RAKE_ground"
    lib.assign(ground, "cobble")

    world = bpy.context.scene.world or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.42, 0.52, 0.68, 1.0)
        bg.inputs[1].default_value = fill      # keep the shadows nearly black
    return sun


def shot(path="/tmp/diku_rake.png", center=(0, 0, 5), dist=26.0, azim=-34.0,
         elev=8.0, lens=52.0, res=1100, samples=24):
    """Render what `rake` lit to a file, because the viewport screenshot is an
    OpenGL preview and the shadow is the whole point of looking."""
    scene = bpy.context.scene
    for obj in list(bpy.data.objects):
        if obj.name.startswith("RAKE_cam"):
            bpy.data.objects.remove(obj, do_unlink=True)
    cam_data = bpy.data.cameras.new("RAKE_cam")
    cam_data.lens = lens
    cam = bpy.data.objects.new("RAKE_cam", cam_data)
    bpy.context.collection.objects.link(cam)
    a, e = math.radians(azim), math.radians(elev)
    cam.location = (center[0] + dist * math.sin(a) * math.cos(e),
                    center[1] - dist * math.cos(a) * math.cos(e),
                    center[2] + dist * math.sin(e))
    cam.rotation_euler = (math.pi / 2 - e, 0.0, a)
    scene.camera = cam
    scene.render.resolution_x = res
    scene.render.resolution_y = int(res * 0.72)
    scene.render.resolution_percentage = 100
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    try:
        scene.eevee.taa_render_samples = samples
        scene.eevee.use_shadows = True
        scene.eevee.use_raytracing = True
    except AttributeError:
        pass
    bpy.ops.render.render(write_still=True)
    return path


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
