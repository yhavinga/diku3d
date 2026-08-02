"""townsperson -- a 1.75 m humanoid with an armature and two baked actions.

The mesh is segmented: every limb is its own closed solid, bound rigidly to one
bone at weight 1.0. That is deliberate rather than a shortcut. A single-skin
humanoid at this triangle count has to be weighted across joints, and a joint
weighted across six triangles pinches into an hourglass the first time you bend
it. Separate solids cannot pinch, they are trivially clean topology, and at the
distance a mobile is ever seen the gap at the elbow is not visible.

Bone rolls are all calculated to global +X, so rotating any bone about its local
X swings it forward and back. Every keyframe in here is an X rotation in
degrees, which makes the walk cycle readable as a table rather than a puzzle.
"""

import math
import importlib

import bpy

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

H = 1.75

# name: (head, tail, parent). Z-up, the figure faces -Y.
BONES = [
    ("hips",        (0.00, 0.00, 0.95), (0.00, 0.00, 1.07), None),
    ("spine",       (0.00, 0.00, 1.07), (0.00, 0.00, 1.31), "hips"),
    ("chest",       (0.00, 0.00, 1.31), (0.00, 0.00, 1.50), "spine"),
    ("neck",        (0.00, 0.00, 1.50), (0.00, 0.00, 1.585), "chest"),
    ("head",        (0.00, 0.00, 1.585), (0.00, 0.00, 1.75), "neck"),
    ("shoulder.L",  (0.045, 0.00, 1.455), (0.205, 0.00, 1.455), "chest"),
    ("upperarm.L",  (0.205, 0.00, 1.455), (0.205, 0.00, 1.175), "shoulder.L"),
    ("forearm.L",   (0.205, 0.00, 1.175), (0.205, 0.00, 0.935), "upperarm.L"),
    ("hand.L",      (0.205, 0.00, 0.935), (0.205, 0.00, 0.815), "forearm.L"),
    ("shoulder.R",  (-0.045, 0.00, 1.455), (-0.205, 0.00, 1.455), "chest"),
    ("upperarm.R",  (-0.205, 0.00, 1.455), (-0.205, 0.00, 1.175), "shoulder.R"),
    ("forearm.R",   (-0.205, 0.00, 1.175), (-0.205, 0.00, 0.935), "upperarm.R"),
    ("hand.R",      (-0.205, 0.00, 0.935), (-0.205, 0.00, 0.815), "forearm.R"),
    ("thigh.L",     (0.092, 0.00, 0.95), (0.092, 0.00, 0.52), "hips"),
    ("shin.L",      (0.092, 0.00, 0.52), (0.092, 0.00, 0.095), "thigh.L"),
    ("foot.L",      (0.092, 0.00, 0.095), (0.092, -0.17, 0.03), "shin.L"),
    ("thigh.R",     (-0.092, 0.00, 0.95), (-0.092, 0.00, 0.52), "hips"),
    ("shin.R",      (-0.092, 0.00, 0.52), (-0.092, 0.00, 0.095), "thigh.R"),
    ("foot.R",      (-0.092, 0.00, 0.095), (-0.092, -0.17, 0.03), "shin.R"),
]


def limb(r, length, loc, bone, mat="cloth", verts=8, name=None):
    obj = lib.cylinder(r, length, loc, verts=verts, name=name or bone, mat=mat)
    return obj, bone


def block(size, loc, bone, mat="cloth", cham=0.03, name=None):
    return kit.timber(size, loc, (0, 0, 0), mat, cham, name or bone), bone


def body():
    """(object, bone) for every solid. Sizes checked against a 1.75 m figure:
    shoulders at 1.45, waist at 1.1, knee at 0.52, ankle at 0.095."""
    parts = [
        # head, with a skull cap of hair so the top is not a flat lid
        block((0.165, 0.185, 0.215), (0, -0.005, 1.665), "head", "skin", 0.045),
        block((0.175, 0.19, 0.075), (0, 0.002, 1.755), "head", "oak", 0.03, "hair"),
        block((0.042, 0.05, 0.085), (0, -0.108, 1.638), "head", "skin", 0.018, "nose"),
        limb(0.055, 0.11, (0, 0, 1.54), "neck", "skin"),
        # torso: three blocks, so it can bend at the waist
        block((0.32, 0.215, 0.24), (0, 0, 1.40), "chest"),
        block((0.30, 0.195, 0.22), (0, 0, 1.19), "spine"),
        block((0.31, 0.205, 0.15), (0, 0, 1.015), "hips"),
        block((0.315, 0.215, 0.055), (0, 0, 1.075), "spine", "oak", 0.02, "belt"),
        # Tunic skirt over the top of the thighs: the one thing that stops the
        # silhouette reading as a shop mannequin.
        block((0.36, 0.27, 0.30), (0, 0, 0.86), "hips", "cloth", 0.04, "tunic"),
        # arms
        block((0.135, 0.16, 0.135), (0.135, 0, 1.45), "shoulder.L"),
        block((0.135, 0.16, 0.135), (-0.135, 0, 1.45), "shoulder.R"),
        limb(0.058, 0.30, (0.205, 0, 1.315), "upperarm.L"),
        limb(0.058, 0.30, (-0.205, 0, 1.315), "upperarm.R"),
        limb(0.05, 0.25, (0.205, 0, 1.055), "forearm.L", "skin"),
        limb(0.05, 0.25, (-0.205, 0, 1.055), "forearm.R", "skin"),
        block((0.07, 0.055, 0.135), (0.205, -0.005, 0.875), "hand.L", "skin", 0.02),
        block((0.07, 0.055, 0.135), (-0.205, -0.005, 0.875), "hand.R", "skin", 0.02),
        # legs
        limb(0.082, 0.44, (0.092, 0, 0.735), "thigh.L"),
        limb(0.082, 0.44, (-0.092, 0, 0.735), "thigh.R"),
        limb(0.065, 0.44, (0.092, 0, 0.305), "shin.L"),
        limb(0.065, 0.44, (-0.092, 0, 0.305), "shin.R"),
        block((0.10, 0.26, 0.09), (0.092, -0.055, 0.048), "foot.L", "oak", 0.025),
        block((0.10, 0.26, 0.09), (-0.092, -0.055, 0.048), "foot.R", "oak", 0.025),
    ]
    return parts


def make_armature():
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    arm = bpy.context.object
    arm.name = "townsperson_rig"
    eb = arm.data.edit_bones
    for b in list(eb):
        eb.remove(b)
    for (name, head, tail, parent) in BONES:
        bone = eb.new(name)
        bone.head, bone.tail = head, tail
        if parent:
            bone.parent = eb[parent]
            bone.use_connect = tuple(eb[parent].tail) == tuple(head)
    bpy.ops.armature.select_all(action="SELECT")
    # Roll every bone so its local X is world +X: then one axis means "forward".
    bpy.ops.armature.calculate_roll(type="GLOBAL_POS_X")
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


# --- animation ------------------------------------------------------------

def key(pb, frame, x=0.0, y=0.0, z=0.0, loc=None):
    pb.rotation_mode = "XYZ"
    pb.rotation_euler = (math.radians(x), math.radians(y), math.radians(z))
    pb.keyframe_insert("rotation_euler", frame=frame)
    if loc is not None:
        pb.location = loc
        pb.keyframe_insert("location", frame=frame)


def action(arm, name, length):
    if arm.animation_data is None:
        arm.animation_data_create()
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = length
    return act


def anim_walk(arm):
    """A 24-frame cycle: two steps, so it loops on itself. Contact at 1 and 13,
    passing at 7 and 19."""
    act = action(arm, "walk", 25)
    p = arm.pose.bones
    swing = [(1, 19), (7, 0), (13, -17), (19, 0), (25, 19)]
    for (f, a) in swing:
        key(p["thigh.L"], f, x=a)
        key(p["thigh.R"], f, x=-a)
        key(p["upperarm.L"], f, x=-a * 0.8)
        key(p["upperarm.R"], f, x=a * 0.8)
    # The knee only ever bends one way, and it bends most just after passing.
    for (f, l, r) in ((1, -5, -24), (7, -27, -5), (13, -24, -5), (19, -5, -27), (25, -5, -24)):
        key(p["shin.L"], f, x=l)
        key(p["shin.R"], f, x=r)
    for (f, l, r) in ((1, 12, -14), (7, -8, 8), (13, -14, 12), (19, 8, -8), (25, 12, -14)):
        key(p["foot.L"], f, x=l)
        key(p["foot.R"], f, x=r)
    for (f, a) in ((1, -14), (7, -18), (13, -14), (19, -18), (25, -14)):
        key(p["forearm.L"], f, x=a)
        key(p["forearm.R"], f, x=a)
    # Hips rise at the passing pose and roll towards the supporting leg.
    for (f, dz, roll) in ((1, 0.0, 0.0), (7, 0.022, 3.0), (13, 0.0, 0.0),
                          (19, 0.022, -3.0), (25, 0.0, 0.0)):
        key(p["hips"], f, y=roll, loc=(0, 0, dz))
    for (f, a) in ((1, 4.0), (7, 0.0), (13, -4.0), (19, 0.0), (25, 4.0)):
        key(p["chest"], f, z=a)
        key(p["head"], f, z=-a * 0.6)
    return act


def anim_idle(arm):
    """Sixty frames of standing about: breathing, a shift of weight and a look
    to one side. Nothing symmetric, or it reads as a machine at rest."""
    act = action(arm, "idle", 61)
    p = arm.pose.bones
    for (f, dz, roll) in ((1, 0.0, 0.0), (18, 0.008, 1.2), (34, 0.013, 1.6),
                          (48, 0.005, 0.7), (61, 0.0, 0.0)):
        key(p["hips"], f, y=roll, loc=(0, 0, dz))
    for (f, a) in ((1, 0.0), (20, -1.6), (40, 0.6), (61, 0.0)):
        key(p["chest"], f, x=a)
        key(p["spine"], f, x=a * 0.5)
    for (f, x, z) in ((1, 0, 0), (16, -2, 9), (30, 1, 5), (44, -1, -7), (61, 0, 0)):
        key(p["head"], f, x=x, z=z)
    for (f, a, b) in ((1, 3, 3), (24, 5, 2), (46, 2, 4), (61, 3, 3)):
        key(p["upperarm.L"], f, x=a, y=-4)
        key(p["upperarm.R"], f, x=b, y=4)
    for (f, a) in ((1, -8), (28, -12), (52, -6), (61, -8)):
        key(p["forearm.L"], f, x=a)
        key(p["forearm.R"], f, x=a * 0.8)
    return act


def build():
    lib.reset()
    parts = body()
    for (obj, bone) in parts:
        vg = obj.vertex_groups.new(name=bone)
        vg.add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    mesh = lib.join([o for (o, _) in parts], "townsperson")
    # Before the armature goes on, while it is still safe to move: the bind is
    # taken from the transform at parent time, so this has to happen first.
    kit.zero_origin(mesh)
    mesh.data.name = "townsperson"
    lib.uv_project(mesh)
    tris = lib.stats([mesh])

    arm = make_armature()
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    # ARMATURE_NAME, not automatic weights: the groups are already exactly right
    # and bone heat would smear them across the gaps between the solids.
    bpy.ops.object.parent_set(type="ARMATURE_NAME")

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    anim_idle(arm)
    anim_walk(arm)
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.animation_data.action = bpy.data.actions["idle"]

    lib.export("townsperson", [arm, mesh],
               export_animations=True,
               export_animation_mode="ACTIONS",
               export_skins=True,
               export_def_bones=False,
               export_bake_animation=True,
               export_optimize_animation_size=False)
    return "%-16s %5d tris  (%d actions)" % ("townsperson", tris,
                                             len([a for a in bpy.data.actions]))
