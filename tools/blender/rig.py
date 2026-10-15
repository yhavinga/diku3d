"""rig -- the skeleton every person and humanoid monster shares, and its clips.

One set of bone names for all of them, so the viewer can drive a guard, a
troll and a skeleton with the same clip names and attach a sword to the same
bone. Proportions come from the body's own table (people.MALE and so on), so
the joints sit where the modelled limbs bend.

Rolls follow the convention townsperson.py settled on after it cost a round:
every bone's local X is on world +X, so for a limb hanging down X swings it
fore and aft (positive backwards), Z swings it out from the body and Y twists
it; for a bone standing up X pitches it (positive forward), Y turns it about
the spine and Z rolls it sideways. `align_roll` aims the bone's *Z* axis at the
vector it is given, so the target is `+X x direction`, which leaves X on +X.

Three bones deform nothing and exist to hold things:

* `grip.R`, `grip.L` -- the inside of a closed fist, in the weapons' frame:
  the bone runs out of the top of the fist (the thumb side), its Z axis down
  the line of the knuckles towards the little finger. A weapon from
  weapons.py parented here with an identity transform sits in the hand.
* `shield.L` -- the grip of a shield on the left arm: the bone runs up the
  forearm towards the elbow and its Z axis points out from the body, which
  is where a shield's face is.

The legs are animated through IK and baked: the clips are authored as where
the feet are on the ground, which is the only way to get a planted foot that
does not skate, and exported as plain rotations.
"""

import math
import importlib

import bpy
import mathutils
from mathutils import Vector, Matrix, Quaternion, Euler

V = Vector

FPS = 24


def bone_table(P):
    """(name, head, tail, parent, deform) in the A-pose the body is modelled in."""
    import people
    hz = P["hip"][2]
    sz = P["shoulder"][2]
    k = (sz - hz) / (1.445 - 0.955)
    z = lambda m: hz + (m - 0.955) * k
    nb = P["neck_base"]
    hj = P["head_joint"]
    crown = P["crown"]
    kf = P["hand"] / 0.185
    out = [
        ("hips", (0, 0.004, hz), (0, 0.004, z(1.075)), None, True),
        ("spine", (0, 0.004, z(1.075)), (0, 0.006, z(1.26)), "hips", True),
        ("chest", (0, 0.006, z(1.26)), (0, 0.010, nb), "spine", True),
        ("neck", (0, 0.010, nb), (0, 0.006, hj), "chest", True),
        ("head", (0, 0.006, hj), (0, 0.006, crown), "neck", True),
    ]
    for (sx, tag) in ((1, "L"), (-1, "R")):
        s, e, w, d = people.arm_axis(P, sx)
        hand_end = w + d * (0.095 * kf)
        out += [
            ("shoulder." + tag, (sx * 0.030, 0.010, s.z - 0.010), tuple(s), "chest", True),
            ("upperarm." + tag, tuple(s), tuple(e), "shoulder." + tag, True),
            ("forearm." + tag, tuple(e), tuple(w), "upperarm." + tag, True),
            ("hand." + tag, tuple(w), tuple(hand_end), "forearm." + tag, True),
        ]
        # The fist: where the curled fingers close, a little in from the palm.
        across = V((0.0, -1.0, 0.0))
        palm_n = V((-sx * math.cos(math.radians(P["arm_a"])), 0.0,
                    -math.sin(math.radians(P["arm_a"]))))
        fist = w + d * (0.072 * kf) + palm_n * (0.018 * kf)
        out.append(("grip." + tag, tuple(fist), tuple(fist + across * 0.10), "hand." + tag, False))
        if tag == "L":
            # Out from the back of the hand, and pointing the way the thumb
            # does: with the forearm carried level, as a shield is, that is up.
            out.append(("shield.L", tuple(fist - palm_n * 0.034),
                        tuple(fist - palm_n * 0.034 + across * 0.10), "hand.L", False))
        h, kn, a = people.leg_axis(P, sx)
        heel_y = a.y + 0.055
        ball = V((a.x, heel_y - 0.180 * kf, 0.022))
        tip = V((a.x, heel_y - 0.262 * kf, 0.018))
        out += [
            ("thigh." + tag, tuple(h), tuple(kn), "hips", True),
            ("shin." + tag, tuple(kn), tuple(a), "thigh." + tag, True),
            ("foot." + tag, tuple(a), tuple(ball), "shin." + tag, True),
            ("toe." + tag, tuple(ball), tuple(tip), "foot." + tag, True),
            # What hangs below the belt swings on these, not on the thighs:
            # a thigh's twin, keyed at bake time to follow it half-way
            # while walking and all the way once it is raised to sit (see
            # `skirt_follow`). Non-deforming until the body is bound.
            ("skirt." + tag, tuple(h), tuple(kn), "hips", False),
            # ...and a shin's, so a long robe falls from the knees when the
            # thighs come up, rather than standing out past them like a tube.
            ("skirt2." + tag, tuple(kn), tuple(a), "skirt." + tag, False),
        ]
    out += face_bones(P)
    return out


# Bones in the face that no clip ever keys: the eyes, which the viewer turns
# towards whatever the person is looking at, and the jaw and the nose, which it
# scales a little per person so a crowd is not one face twenty times. They
# point forward out of the face, so their local Y is the line of sight (or of
# the nose) and X is the figure's left, like every other bone here. Created
# non-deforming, so bone heat on the body never hands them the neck; switched
# to deforming once the body is bound (`deform_face`).
#
# The hair's chain is of the same kind: three bones hanging from the back of
# the crown down the nape, which only the viewer's spring moves (a ponytail,
# a plait and a tail are weighted to them in hair.py).
HAIR_BONES = ("hairtail.1", "hairtail.2", "hairtail.3")
FACE_BONES = ("eye.L", "eye.R", "jaw", "nose") + HAIR_BONES
SKIRT_BONES = ("skirt.L", "skirt.R", "skirt2.L", "skirt2.R")


def face_bones(P):
    import heads
    S = heads.spec_for(P)
    ex, ey, ez = S["eye"]
    fwd = (0.0, -0.02, 0.0)
    out = []
    for (sx, tag) in ((1, "L"), (-1, "R")):
        c = heads.canon_to_world(P, (sx * ex, ey, ez))
        out.append(("eye." + tag, c, tuple(V(c) + V(fwd)), "head", False))
    for name, at in (("jaw", heads.JAW_PIVOT), ("nose", heads.NOSE_PIVOT)):
        c = heads.canon_to_world(P, at)
        out.append((name, c, tuple(V(c) + V(fwd)), "head", False))
    # In the head's canonical frame (y back, z up), down the line of the nape.
    # The joints are where the hair bends. One chain serves four styles whose
    # ties are at different heights, so it starts at the back of the skull and
    # each style's weights (hair.py `hang_weights`) say where along it they hang.
    chain = ((0.092, 0.050), (0.104, -0.040), (0.106, -0.140), (0.108, -0.250))
    for i, name in enumerate(HAIR_BONES):
        a = heads.canon_to_world(P, (0.0, chain[i][0], chain[i][1]))
        b = heads.canon_to_world(P, (0.0, chain[i + 1][0], chain[i + 1][1]))
        out.append((name, a, b, "head" if i == 0 else HAIR_BONES[i - 1], False))
    return out


def deform_face(arm):
    """Switch on the bones bone heat must not hand the body to: the face's
    and the skirts'. Everything weighted to them is weighted by hand."""
    select_only([arm], arm)
    for n in FACE_BONES + SKIRT_BONES:
        if n in arm.data.bones:
            arm.data.bones[n].use_deform = True


# The Z axis each holding bone's roll aims at, in the A-pose.
def _hold_axis(name, P):
    import people
    sx = 1 if name.endswith(".L") else -1
    s, e, w, d = people.arm_axis(P, sx)
    if name.startswith("grip"):
        return d                                 # down the knuckles
    palm_n = V((-sx * math.cos(math.radians(P["arm_a"])), 0.0,
                -math.sin(math.radians(P["arm_a"]))))
    return -palm_n                               # out from the body


def build_armature(P, name="rig"):
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    arm = bpy.context.object
    arm.name = name
    arm.data.name = name
    eb = arm.data.edit_bones
    for b in list(eb):
        eb.remove(b)
    for (bname, head, tail, parent, deform) in bone_table(P):
        bone = eb.new(bname)
        bone.head, bone.tail = head, tail
        bone.use_deform = deform
        if parent:
            bone.parent = eb[parent]
            bone.use_connect = (V(eb[parent].tail) - V(head)).length < 1e-6
    _roll(arm, P)
    bpy.ops.object.mode_set(mode="OBJECT")
    import people
    # Where the middle of the head is, in the head bone's own frame: kept
    # here because a hunch reposes the bone and the head goes with it.
    arm["head_center"] = tuple(arm.data.bones["head"].matrix_local.inverted() @ people.head_center(P))
    arm["troll"] = bool(P.get("troll"))
    return arm


def _roll(arm, P, holders=True):
    """Every bone's X onto world +X (see the module docstring); the holding
    bones get their own frame. Must be called in edit mode."""
    for bone in arm.data.edit_bones:
        if bone.name.startswith(("grip", "shield")):
            if holders:
                bone.align_roll(_hold_axis(bone.name, P))
            continue
        direction = (bone.tail - bone.head).normalized()
        target = V((1.0, 0.0, 0.0)).cross(direction)
        bone.align_roll(target if target.length > 1e-4 else V((0.0, 0.0, 1.0)))


def select_only(objs, active):
    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def bind_heat(arm, mesh):
    """Bone heat, which is what a rigger starts from on a closed skin."""
    select_only([mesh, arm], arm)
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    missing = [v.index for v in mesh.data.vertices if not v.groups]
    if missing:
        raise RuntimeError("bone heat left %d vertices of %s unweighted" % (len(missing), mesh.name))
    # Heat hands a joint over from one bone to the next in a band a couple of
    # centimetres wide. At the shoulder that is a crease: swinging the A-pose
    # arm down to the side tore the top of the arm away from the torso in a
    # lip, and every tunic cut from it wore the lip as a padded shoulder.
    # Relaxed, the hand-over spreads and the joint bends as flesh does.
    select_only([mesh], mesh)
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    bpy.ops.object.vertex_group_smooth(group_select_mode="ALL", factor=0.5, repeat=6, expand=0.2)
    bpy.ops.object.mode_set(mode="OBJECT")
    return mesh


def bind_groups(arm, mesh):
    """Parent with the vertex groups already on the mesh."""
    select_only([mesh, arm], arm)
    bpy.ops.object.parent_set(type="ARMATURE_NAME")
    return mesh


def set_rigid(mesh, bone, verts=None):
    """Weight these vertices (all by default) wholly to one bone."""
    idx = list(range(len(mesh.data.vertices))) if verts is None else list(verts)
    for g in mesh.vertex_groups:
        if g.name != "HEADISLAND":
            g.remove(idx)
    g = mesh.vertex_groups.get(bone) or mesh.vertex_groups.new(name=bone)
    g.add(idx, 1.0, "REPLACE")


def arms_down(arm, meshes, P, splay=6.0):
    """Pose the A-pose arms down to the sides, bake that into the meshes and
    make it the rest pose. The bind came from the A-pose, where bone heat can
    tell an arm from a flank; the rest pose is the one the clips are written
    against."""
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode="POSE")
    for (sx, tag) in ((1, "L"), (-1, "R")):
        pb = arm.pose.bones["upperarm." + tag]
        head = arm.matrix_world @ pb.head
        a = math.radians(P["arm_a"])
        cur = V((sx * math.sin(a), 0.0, -math.cos(a)))
        want = V((sx * math.sin(math.radians(splay)), 0.0, -math.cos(math.radians(splay))))
        q = cur.rotation_difference(want)
        R = Matrix.Translation(pb.head) @ q.to_matrix().to_4x4() @ Matrix.Translation(-pb.head)
        pb.matrix = R @ pb.matrix
        bpy.context.view_layer.update()
    bpy.ops.object.mode_set(mode="OBJECT")
    for mesh in meshes:
        mod = next(m for m in mesh.modifiers if m.type == "ARMATURE")
        select_only([mesh], mesh)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="EDIT")
    _roll_down(arm)
    bpy.ops.object.mode_set(mode="OBJECT")
    for mesh in meshes:
        mod = mesh.modifiers.new("armature", "ARMATURE")
        mod.object = arm


def repose(arm, meshes, angles):
    """Bake a pose into the meshes and make it the rest pose: a troll's
    hunch, so every clip played on it keeps the hunch without knowing."""
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode="POSE")
    for name, (x, y, z) in angles.items():
        pb = arm.pose.bones[name]
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (math.radians(x), math.radians(y), math.radians(z))
    bpy.context.view_layer.update()
    bpy.ops.object.mode_set(mode="OBJECT")
    for mesh in meshes:
        mod = next(m for m in mesh.modifiers if m.type == "ARMATURE")
        select_only([mesh], mesh)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="EDIT")
    _roll_down(arm)
    bpy.ops.object.mode_set(mode="OBJECT")
    for mesh in meshes:
        mod = mesh.modifiers.new("armature", "ARMATURE")
        mod.object = arm


def _roll_down(arm):
    """Rolls again on the arms-down rest pose; the holders keep theirs, which
    came through the rotation with the hand."""
    for bone in arm.data.edit_bones:
        if bone.name.startswith(("grip", "shield")):
            continue
        direction = (bone.tail - bone.head).normalized()
        target = V((1.0, 0.0, 0.0)).cross(direction)
        bone.align_roll(target if target.length > 1e-4 else V((0.0, 0.0, 1.0)))


# --- controls ---------------------------------------------------------------

CONTROLS = ("foot_ik.L", "foot_ik.R", "pole.L", "pole.R")


def add_controls(arm):
    """IK for the legs: a free target per foot (a copy of the foot bone) and a
    knee pole riding in front of it. The shin solves the knee, the foot copies
    the target's rotation, so a key on the target is a key on where the sole
    is -- which is what a walk has to be authored in."""
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones
    for tag in ("L", "R"):
        foot = eb["foot." + tag]
        ik = eb.new("foot_ik." + tag)
        ik.head, ik.tail, ik.roll = foot.head, foot.tail, foot.roll
        ik.use_deform = False
        knee = eb["shin." + tag].head
        pole = eb.new("pole." + tag)
        pole.head = knee + V((0.0, -0.6, 0.0))
        pole.tail = pole.head + V((0.0, -0.1, 0.0))
        pole.use_deform = False
        # On the hips, not the foot: a foot pitched forty degrees at toe-off
        # would swing a pole riding on it into the ground, and the knee after it.
        pole.parent = eb["hips"]
    bpy.ops.object.mode_set(mode="POSE")
    for tag in ("L", "R"):
        shin = arm.pose.bones["shin." + tag]
        c = shin.constraints.new("IK")
        c.name = "IK"
        c.target = arm
        c.subtarget = "foot_ik." + tag
        c.pole_target = arm
        c.pole_subtarget = "pole." + tag
        c.chain_count = 2
        c.use_tail = True
        c.use_stretch = False
        foot = arm.pose.bones["foot." + tag]
        r = foot.constraints.new("COPY_ROTATION")
        r.name = "IKrot"
        r.target = arm
        r.subtarget = "foot_ik." + tag
    # The pole angle that leaves the rest pose where it was: whichever of the
    # four the knee does not move under is the right one for these rolls.
    bpy.context.view_layer.update()
    for tag in ("L", "R"):
        c = arm.pose.bones["shin." + tag].constraints["IK"]
        rest = arm.data.bones["shin." + tag].head_local.copy()
        best = None
        for deg in (-90, 0, 90, 180):
            c.pole_angle = math.radians(deg)
            bpy.context.view_layer.update()
            err = (arm.pose.bones["shin." + tag].head - rest).length
            err += (arm.pose.bones["shin." + tag].tail - arm.data.bones["shin." + tag].tail_local).length
            if best is None or err < best[0]:
                best = (err, deg)
        c.pole_angle = math.radians(best[1])
        if best[0] > 0.002:
            raise RuntimeError("no pole angle keeps the %s knee at rest (%.4f m)" % (tag, best[0]))
    bpy.ops.object.mode_set(mode="OBJECT")


def ik_on(arm, on):
    for tag in ("L", "R"):
        arm.pose.bones["shin." + tag].constraints["IK"].influence = 1.0 if on else 0.0
        arm.pose.bones["foot." + tag].constraints["IKrot"].influence = 1.0 if on else 0.0


# --- keying -----------------------------------------------------------------

def new_action(arm, name):
    if arm.animation_data is None:
        arm.animation_data_create()
    act = bpy.data.actions.new("_" + name)
    arm.animation_data.action = act
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.location = (0, 0, 0)
        pb.rotation_euler = (0, 0, 0)
    return act


def fk(pb, frame, x=0.0, y=0.0, z=0.0):
    pb.rotation_mode = "XYZ"
    pb.rotation_euler = (math.radians(x), math.radians(y), math.radians(z))
    pb.keyframe_insert("rotation_euler", frame=frame)


def place(arm, name, frame, M):
    """Put a bone at an armature-space matrix and key it (location and
    rotation). Used for the controls and the hips."""
    pb = arm.pose.bones[name]
    pb.rotation_mode = "XYZ"
    pb.matrix = M
    bpy.context.view_layer.update()
    pb.keyframe_insert("location", frame=frame)
    pb.keyframe_insert("rotation_euler", frame=frame)


def foot_matrix(arm, tag, ankle, pitch=0.0, yaw=0.0):
    """The foot target with its ankle at `ankle` (armature space), the foot
    pitched `pitch` degrees toe-up about the ankle and turned `yaw` about Z."""
    rest = arm.data.bones["foot." + tag].matrix_local.copy()
    # Rotation about +X by +a takes the toe (-Y) downward, so toe-up is -a.
    R = (Matrix.Rotation(math.radians(yaw), 4, "Z") @
         Matrix.Rotation(math.radians(-pitch), 4, "X"))
    rot = R @ Matrix(rest.to_3x3()).to_4x4()
    return Matrix.Translation(V(ankle)) @ rot


def hips_matrix(arm, offset=(0, 0, 0), pitch=0.0, yaw=0.0, roll=0.0):
    """Hips moved by `offset` (world metres: x left, y back, z up) and turned
    about the hip joint: pitch forward, yaw left, roll to the left side."""
    rest = arm.data.bones["hips"].matrix_local.copy()
    head = rest.to_translation()
    R = (Matrix.Rotation(math.radians(yaw), 4, "Z") @
         Matrix.Rotation(math.radians(pitch), 4, "X") @
         Matrix.Rotation(math.radians(roll), 4, "Y"))
    return Matrix.Translation(head + V(offset)) @ R @ Matrix(rest.to_3x3()).to_4x4()


def rest_ankle(arm, tag):
    return arm.data.bones["foot." + tag].head_local.copy()


# --- baking -----------------------------------------------------------------

def bake(arm, act, frames):
    """Evaluate the rig with its IK every frame and record each deforming
    bone's local transform, so the exported clip is plain rotations that
    three can play without a solver. Returns the samples; `commit` writes
    them into a clean action once the controls are gone."""
    arm.animation_data.action = act
    # The face bones are the viewer's to move, not the clips': a clip that
    # carried them would put every eye back to the front every frame.
    names = [b.name for b in arm.data.bones if b.name not in CONTROLS and b.name not in FACE_BONES]
    samples = []
    scene = bpy.context.scene
    for f in range(frames[0], frames[1] + 1):
        scene.frame_set(f)
        bpy.context.view_layer.update()
        row = {}
        for n in names:
            pb = arm.pose.bones[n]
            M = arm.convert_space(pose_bone=pb, matrix=pb.matrix, from_space="POSE", to_space="LOCAL")
            row[n] = (M.to_translation(), M.to_quaternion())
        for t in "LR":
            if "skirt." + t in row:
                g = skirt_follow(row["thigh." + t][1])
                row["skirt." + t] = (V((0.0, 0.0, 0.0)), _part(row["thigh." + t][1], g))
                row["skirt2." + t] = (V((0.0, 0.0, 0.0)), _part(row["shin." + t][1], g))
        samples.append(row)
    return samples


def skirt_follow(q):
    """How much of its thigh's rotation a skirt bone takes (and of its shin's,
    the skirt bone below it): half at a walk -- the cloth swings with the
    stride without splitting into two tubes -- rising to all of it by the
    time the thigh is raised to sit, so the skirt comes up over the seat and
    falls from the knees. Hung from the hips at a walk's share, a robe went
    straight down through the bench, 12-20 cm deep, under every sitter."""
    if q.w < 0:
        q = -q
    a = math.degrees(q.angle)
    t = max(0.0, min(1.0, (a - 30.0) / 45.0))
    return 0.5 + 0.5 * t * t * (3 - 2 * t)


def _part(q, g):
    if q.w < 0:
        q = -q
    return Quaternion().slerp(q, g)


def commit(arm, name, samples, start=0):
    """Frame 0, not 1: the exporter writes a key at frame f to time f / fps,
    so a clip keyed from 1 comes out with a held first frame in front of it
    and loops with a hitch."""
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    prev = {}
    for i, row in enumerate(samples):
        f = start + i
        for n, (loc, q) in row.items():
            pb = arm.pose.bones[n]
            pb.rotation_mode = "QUATERNION"
            # Keep the quaternion on the same hemisphere as the frame before,
            # or the interpolation between them goes the long way round.
            if n in prev and prev[n].dot(q) < 0:
                q = -q
            prev[n] = q
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=f)
            if n == "hips" or loc.length > 1e-5:
                pb.location = loc
                pb.keyframe_insert("location", frame=f)
    return act


def strip_controls(arm):
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode="POSE")
    for pb in arm.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
    bpy.ops.object.mode_set(mode="EDIT")
    for n in CONTROLS:
        b = arm.data.edit_bones.get(n)
        if b:
            arm.data.edit_bones.remove(b)
    bpy.ops.object.mode_set(mode="OBJECT")


# --- locomotion ---------------------------------------------------------------

def _smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def _hermite(p0, p1, m0, m1, t):
    t2, t3 = t * t, t * t * t
    return ((2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 +
            (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1)


def _interp(table, x):
    if x <= table[0][0]:
        return table[0][1]
    for (x0, a), (x1, b) in zip(table, table[1:]):
        if x <= x1:
            t = (x - x0) / (x1 - x0)
            t = t * t * (3 - 2 * t)
            return a + (b - a) * t
    return table[-1][1]


class Gait:
    """A locomotion cycle worked out from the ground up.

    The body is animated in place, and the viewer moves the figure along at
    `stride / cycle` metres a second. So a foot on the ground has to travel
    backwards under the body at exactly that speed, whatever else is going on,
    or it skates. Here that is the definition of stance: the contact point --
    the heel, then the whole sole, then the ball of the foot -- moves back at
    ground speed while the foot rolls over it, and the ankle is wherever that
    rolling puts it. Swing is then free, and is a curve from one footprint to
    the next with the toe held clear of the ground.

    The hips come last: as high as the planted leg allows, never higher, so
    the leg is never asked to be longer than it is and the IK never gives up
    and lets the foot drift."""

    def __init__(self, arm, frames, stride, stance, lift, pitch_strike, pitch_off,
                 lean=3.0, sway=0.015, yaw=5.0, roll=3.0, bob=0.0, aft=0.01, reach=0.998, kick=0.85,
                 direction=None, cross=0.0):
        self.arm = arm
        # Which way a planted foot travels under the body, (x, y) in the
        # armature's frame; None is the old +y (a body walking forward) and
        # takes the exact arithmetic it always had. `cross` carries a swinging
        # foot that far forward past the planted one, for a sideways gait
        # whose feet would otherwise pass through each other.
        self.dir = direction
        self.cross = cross
        self.frames = frames
        self.stride = stride
        self.beta = stance
        self.lift = lift
        self.ps, self.po = pitch_strike, pitch_off
        self.lean, self.sway, self.yaw, self.roll, self.bob = lean, sway, yaw, roll, bob
        self.aft, self.reach, self.kick = aft, reach, kick
        b = arm.data.bones
        self.ankle = {t: b["foot." + t].head_local.copy() for t in "LR"}
        self.ball = {t: b["toe." + t].head_local.copy() for t in "LR"}
        self.hipj = {t: b["thigh." + t].head_local.copy() for t in "LR"}
        self.leg = {t: b["thigh." + t].length + b["shin." + t].length for t in "LR"}
        self.hips_head = b["hips"].head_local.copy()

    def pitch(self, ph):
        """Foot pitch, toe-up positive, over one cycle from heel strike."""
        be = self.beta
        return _interp([(0.0, self.ps), (0.09 * be / 0.62, 0.0), (0.58 * be, 0.0),
                        (be, self.po), (be + 0.10, self.po * 0.5), (0.86, 4.0),
                        (1.0, self.ps)], ph)

    def contact(self, tag, ph):
        """Ankle position and pitch for the foot whose heel strikes at ph = 0."""
        A = self.ankle[tag]
        heel = V((A.x, A.y + 0.055, 0.0))
        ball = V((A.x, self.ball[tag].y, 0.0))
        rest_heel = heel.copy()
        be = self.beta
        if ph <= be:
            p = self.pitch(ph)
            # Mid-stance puts the heel where it rests, a touch forward of the
            # hip, so the stride is shared evenly fore and aft.
            if self.dir is None:
                y = rest_heel.y + self.stride * (ph - be / 2) + self.aft
                h = V((A.x, y, 0.0))
            else:
                s = self.stride * (ph - be / 2) + self.aft
                h = V((A.x + self.dir[0] * s, rest_heel.y + self.dir[1] * s, 0.0))
            if p >= 0:
                pivot, off = h, A - heel
            else:
                pivot, off = h + (ball - heel), A - ball
            R = Matrix.Rotation(math.radians(-p), 3, "X")
            return pivot + R @ off, p
        # Swing: from where toe-off left the ankle to where the next strike wants it.
        s = (ph - be) / (1.0 - be)
        a0, p0 = self.contact(tag, be)
        a1, p1 = self.contact(tag, 0.0)
        v = self.stride / 1.0            # metres per cycle, in cycle time
        u = self.dir or (0.0, 1.0)
        m0 = V((u[0] * v * (1.0 - be) * 0.6, u[1] * v * (1.0 - be) * 0.6, 0.0))
        m1 = V((u[0] * v * (1.0 - be) * 0.4, u[1] * v * (1.0 - be) * 0.4, 0.0))
        pos = _hermite(a0, a1, m0, m1, s)
        pos.z += self.lift * math.sin(math.pi * min(1.0, s ** self.kick))
        if self.cross:
            pos.y -= self.cross * math.sin(math.pi * s)
        return pos, self.pitch(ph)

    def key(self):
        arm = self.arm
        n = self.frames
        rows = []
        for f in range(n + 1):
            ph = f / n
            feet = {"L": self.contact("L", ph), "R": self.contact("R", (ph + 0.5) % 1.0)}
            rows.append(feet)
        # Hips: the highest the legs allow, eased round the cycle.
        dz = []
        for f in range(n + 1):
            ph = f / n
            off = V((self.sway * math.cos(2 * math.pi * (ph - self.beta / 2)), 0.0, 0.0))
            H = hips_matrix(arm, off, self.lean, -self.yaw * math.cos(2 * math.pi * ph),
                            -self.roll * math.cos(2 * math.pi * (ph - self.beta / 2)))
            rest = arm.data.bones["hips"].matrix_local
            allow = 0.0
            for t in "LR":
                j = H @ (rest.inverted() @ self.hipj[t])
                a, _ = rows[f][t]
                reach = self.leg[t] * self.reach
                flat = (j.xy - a.xy).length
                top = a.z + math.sqrt(max(0.0, reach * reach - flat * flat))
                allow = min(allow, top - j.z)
            dz.append(allow)
        m = len(dz) - 1
        eased = []
        for f in range(n + 1):
            vals = [dz[(f + k) % m] for k in range(-1, 2)]
            eased.append(min(dz[f], sum(vals) / 3.0) - 0.002)
        for f in range(n + 1):
            ph = f / n
            frame = f + 1
            off = V((self.sway * math.cos(2 * math.pi * (ph - self.beta / 2)), 0.0,
                     eased[f] + self.bob * math.cos(4 * math.pi * (ph - self.beta / 2))))
            place(arm, "hips", frame, hips_matrix(
                arm, off, self.lean, -self.yaw * math.cos(2 * math.pi * ph),
                -self.roll * math.cos(2 * math.pi * (ph - self.beta / 2))))
            for t in "LR":
                a, p = rows[f][t]
                place(arm, "foot_ik." + t, frame, foot_matrix(arm, t, a, p))
                # Rolled up onto the ball, the foot would carry the toes down
                # through the ground with it -- 4.7 cm on a man at toe-off,
                # 11 on a troll's claws. They stay flat and bend at the ball.
                fk(arm.pose.bones["toe." + t], frame, x=min(0.0, p))
        return eased


def upper_locomotion(arm, frames, swing, elbow, lean_chest=0.0, counter=3.0, gait=None,
                     arm_out=4.0, hand=0.0):
    """Arms, spine and head over a locomotion cycle. The arm opposite the
    forward leg swings forward, the chest turns against the hips, and the
    head is held level and facing the way the body is going -- every turn
    below it is cancelled at the neck and the skull."""
    p = arm.pose.bones
    yaw = gait.yaw if gait else 5.0
    for f in range(frames + 1):
        ph = f / frames
        c = math.cos(2 * math.pi * ph)
        frame = f + 1
        hip_yaw = -yaw * c
        fk(p["spine"], frame, x=lean_chest * 0.4, y=counter * 0.5 * c)
        fk(p["chest"], frame, x=lean_chest * 0.6, y=counter * c)
        # Undo the turn and the lean of everything below the neck.
        total = hip_yaw + counter * 1.5 * c
        lean = (gait.lean if gait else 0.0) + lean_chest
        fk(p["neck"], frame, x=-lean * 0.45, y=-total * 0.5)
        fk(p["head"], frame, x=-lean * 0.55, y=-total * 0.5)
        # Left arm is back while the left leg is forward (ph = 0).
        for (t, sgn, out) in (("L", 1.0, -arm_out), ("R", -1.0, arm_out)):
            a = swing * c * sgn
            fwd = max(0.0, -a) / max(swing, 1e-3)
            fk(p["upperarm." + t], frame, x=a, z=out)
            fk(p["forearm." + t], frame, x=-(elbow + elbow * 0.8 * fwd))
            fk(p["hand." + t], frame, x=hand - 6 * fwd, z=0.0)


def _leg_scale(arm):
    """Stride goes with leg length: a man's leg is 0.866 m hip to ankle."""
    b = arm.data.bones
    return (b["thigh.L"].length + b["shin.L"].length) / 0.866


def anim_walk(arm):
    new_action(arm, "walk")
    n = 26
    g = Gait(arm, n, stride=1.20 * _leg_scale(arm), stance=0.62, lift=0.055, pitch_strike=14.0,
             pitch_off=-34.0, lean=3.0, sway=0.016, yaw=6.0, roll=3.0)
    g.key()
    upper_locomotion(arm, n, swing=17.0, elbow=12.0, counter=3.0, gait=g)
    return "walk", (1, n + 1), dict(stride=g.stride, stance=g.beta)


def anim_run(arm):
    new_action(arm, "run")
    n = 16
    # The heel kicks up behind early in the swing (kick < 1 puts the top of
    # the lift early), which is the fold of the leg that tells a run from a
    # long walk.
    g = Gait(arm, n, stride=2.60 * _leg_scale(arm), stance=0.36, lift=0.30, pitch_strike=10.0,
             pitch_off=-44.0, lean=10.0, sway=0.010, yaw=7.0, roll=3.0, bob=0.025,
             kick=0.55)
    g.key()
    upper_locomotion(arm, n, swing=34.0, elbow=62.0, lean_chest=4.0, counter=6.0, gait=g,
                     arm_out=8.0, hand=-8.0)
    return "run", (1, n + 1), dict(stride=g.stride, stance=g.beta)


# --- measuring ----------------------------------------------------------------

def foot_slip(arm, frames, stride, stance, direction=None):
    """Worst drift of a planted foot, in metres, over a locomotion clip, read
    off the deforming bones -- so it can be run on the baked clip with the IK
    gone, which is the one that ships.

    Planted is the stance phase the gait was built with, less a frame at each
    end. Within it the contact point is whichever of the heel and the ball
    is lower; that point plus the ground the figure has covered since the
    cycle began should not move. Also returns the lowest either point goes,
    which is how far a sole sinks into the paving. `direction` is the way the
    planted foot travels under the body (Gait's), None for +y; the drift is
    then the spread of the contact point along and across it."""
    scene = bpy.context.scene
    n = frames[1] - frames[0]
    speed = stride / n
    worst, sink = 0.0, 0.0
    for t, start in (("L", 0.0), ("R", 0.5)):
        seen = []
        bone = arm.data.bones["foot." + t]
        heel_rest = V((bone.head_local.x, bone.head_local.y + 0.055, 0.0))
        for f in range(frames[0], frames[1] + 1):
            ph = ((f - frames[0]) / n - start) % 1.0
            scene.frame_set(f)
            pb = arm.pose.bones["foot." + t]
            heel = pb.matrix @ (bone.matrix_local.inverted() @ heel_rest)
            ball_rest = arm.data.bones["toe." + t].head_local.copy()
            ball_rest.z = 0.0
            ball = pb.matrix @ (bone.matrix_local.inverted() @ ball_rest)
            sink = min(sink, heel.z, ball.z)
            if not (1.0 / n < ph < stance - 1.0 / n):
                continue
            p = heel if heel.z <= ball.z else ball
            plant = math.floor((f - frames[0]) / n - start)
            if direction is None:
                at = p.y - speed * (f - frames[0])
            else:
                dist = speed * (f - frames[0])
                at = (p.x - direction[0] * dist, p.y - direction[1] * dist)
            seen.append((at, ("heel" if p is heel else "ball", plant), f))
        # Drift within each run of the same contact point.
        runs = {}
        for (y, k, f) in seen:
            runs.setdefault(k, []).append(y)
        for ys in runs.values():
            if direction is None:
                worst = max(worst, max(ys) - min(ys))
            else:
                worst = max(worst, max(math.hypot(a[0] - b[0], a[1] - b[1]) for a in ys for b in ys))
    return worst, sink


def head_clearance(arm, P, frames, limbs=("forearm", "hand"), margin=0.045):
    """The least gap, in metres, between the arms and the head over a clip:
    points down each forearm and hand against the head's ellipsoid, carried
    by the head bone, with `margin` for the flesh and the sleeve round the
    bone. Negative is an arm through the skull -- which a review found the
    overhand cut doing to every unarmed man and every troll."""
    import people
    scene = bpy.context.scene
    hb = arm.data.bones["head"]
    hc = V(arm["head_center"])
    hw, hd, hh = P["head"]
    radii = V((hw + 0.012, hd + 0.012, hh + 0.010))
    worst = (9.0, None, None)
    for f in range(frames[0], frames[1] + 1):
        scene.frame_set(f)
        H = arm.pose.bones["head"].matrix
        Hi = H.inverted()
        for t in "LR":
            for limb in limbs:
                pb = arm.pose.bones[limb + "." + t]
                for k in range(6):
                    p = pb.head + (pb.tail - pb.head) * (k / 5.0)
                    # Into the head bone's rest frame, where the ellipsoid is
                    # axis-aligned with the figure.
                    q = hb.matrix_local @ (Hi @ p)
                    c = hb.matrix_local @ hc
                    d = q - c
                    r = V((d.x / radii.x, d.y / radii.y, d.z / radii.z)).length
                    gap = (r - 1.0) * min(radii) - margin
                    if gap < worst[0]:
                        worst = (gap, f, limb + "." + t)
    return worst


# --- poses --------------------------------------------------------------------

# Where the feet stand, per stance: (ankle offset from rest (x, y), yaw, pitch).
STANCES = {
    "rest": {"L": ((0.004, 0.0), 6.0, 0.0), "R": ((-0.004, 0.0), -6.0, 0.0)},
    # Left foot leading, right foot back and turned out: a swordsman's stance.
    "guard": {"L": ((0.030, -0.200), 16.0, 0.0), "R": ((-0.040, 0.210), -38.0, 0.0)},
    "lunge": {"L": ((0.030, -0.330), 12.0, 0.0), "R": ((-0.040, 0.210), -38.0, 0.0)},
    # Seated: both feet a pace forward of the hips, a little apart.
    "sit": {"L": ((0.020, -0.340), 8.0, 0.0), "R": ((-0.020, -0.340), -8.0, 0.0)},
    # Leaning on a wall: the left foot crossed in front of the right.
    "lean": {"L": ((-0.080, -0.110), -10.0, 0.0), "R": ((0.010, 0.020), -8.0, 0.0)},
}


def stance_feet(arm, name, frame):
    for t in "LR":
        (dx, dy), yaw, pitch = STANCES[name][t]
        a = rest_ankle(arm, t) + V((dx, dy, 0.0))
        place(arm, "foot_ik." + t, frame, foot_matrix(arm, t, a, pitch, yaw))


def pose(arm, frame, bones, hips=None, stance="rest", feet=True):
    """One key: FK angles per bone (x, y, z degrees in the conventions at the
    top of this file), the hips as (offset, pitch, yaw, roll), the feet by
    stance. Bones not named are keyed at rest, so every key is a whole pose
    and a clip never inherits a stray angle from the one built before it."""
    p = arm.pose.bones
    if hips is None:
        hips = ((0, 0, 0), 0, 0, 0)
    off, pitch, yaw, roll = hips
    place(arm, "hips", frame, hips_matrix(arm, off, pitch, yaw, roll))
    if feet:
        stance_feet(arm, stance, frame)
    for pb in p:
        if pb.name in CONTROLS or pb.name in FACE_BONES or pb.name == "hips" or pb.name.startswith(("grip", "shield")):
            continue
        if pb.name.startswith(("thigh", "shin", "foot")):
            continue
        fk(pb, frame, *bones.get(pb.name, (0, 0, 0)))


def mirror(bones):
    return {k: v for k, v in bones.items()}


def blend(a, b, t):
    """Pose a towards pose b by t, bone by bone."""
    out = {}
    for k in set(a) | set(b):
        va, vb = a.get(k, (0, 0, 0)), b.get(k, (0, 0, 0))
        out[k] = tuple(x + (y - x) * t for x, y in zip(va, vb))
    return out


def merge(*ds):
    out = {}
    for d in ds:
        out.update(d)
    return out


# --- the clips ------------------------------------------------------------------

# The guard every combat clip starts and ends in, so the viewer can cut
# between fight, attack, block and hit with nothing to blend but timing. Sword
# up and forward in the right hand, shield square to the front on the left
# forearm, left foot leading and the hips turned to put the shield side on.
GUARD_HIPS = ((0.0, 0.0, -0.06), 6.0, -25.0, 0.0)
GUARD = {
    "spine": (4, 8, 0), "chest": (4, 10, 0), "neck": (-4, 4, 0), "head": (-6, 4, 0),
    "upperarm.R": (-35, 0, 25), "forearm.R": (-85, 0, 0), "hand.R": (50, 0, 0),
    "upperarm.L": (-32, 40, 12), "forearm.L": (-92, 0, 0), "hand.L": (0, 0, 45),
}
HANG = {"upperarm.L": (2, 0, -4), "upperarm.R": (2, 0, 4),
        "forearm.L": (-10, 0, 0), "forearm.R": (-10, 0, 0)}

# Single-frame arm poses that stand in for the swinging arm in the walking
# and standing clips of anyone carrying something: the viewer swaps these
# tracks in per archetype, so a spearman's idle keeps its breathing and loses
# only the arm that holds the spear.
CARRY = {
    # Forearm level, thumb up: a pole held upright beside the body.
    "carry_pole": {"upperarm.R": (0, 0, 7), "forearm.R": (-80, 0, 0), "hand.R": (8, 0, 0)},
    # A drawn blade held low, point forward and down.
    "carry_blade": {"upperarm.R": (4, 0, 6), "forearm.R": (-22, 0, 0), "hand.R": (58, 0, 0)},
    # Forearm level through the straps: the shield hangs at the side, face out.
    "carry_shield": {"upperarm.L": (6, 0, -14), "forearm.L": (-84, 0, 0), "hand.L": (0, 0, 0)},
}


def _clip(arm, name, keys):
    """keys: [(frame, bones, hips, stance)]."""
    new_action(arm, name)
    for (f, bones, hips, stance) in keys:
        pose(arm, f, bones, hips, stance)
    return keys[-1][0]


def anim_idle(arm):
    """Two seconds of standing: breath in the chest, the weight moving from
    foot to foot through the hips while the feet stay put, and the head
    drifting. Nothing symmetric, or it reads as a machine at rest."""
    k = []
    for (f, sway, roll, breath, turn, nod) in ((1, 0.0, 0.0, 0.0, 0, 0), (13, 0.011, -1.4, -1.6, 5, -2),
                                               (25, 0.004, -0.6, -0.4, 7, 1),
                                               (37, -0.010, 1.3, 0.8, -4, -1), (49, 0.0, 0.0, 0.0, 0, 0)):
        b = merge(HANG, {"spine": (breath * 0.5, 0, 0), "chest": (breath, 0, 0),
                         "neck": (nod * 0.5, turn * 0.4, 0), "head": (nod, turn * 0.6, 0),
                         "forearm.L": (-10 + breath * 1.5, 0, 0), "forearm.R": (-12 + breath, 0, 0)})
        k.append((f, b, ((sway, 0.0, -0.004 - abs(sway) * 0.3), 0.0, 0.0, roll), "rest"))
    return "idle", (1, _clip(arm, "idle", k))


def anim_idle2(arm):
    """Three seconds of looking about: over one shoulder, then the other, the
    chest turning a little with the head, then a hand up to rub the back of
    the neck. The other idle, so a crowd is not all breathing in step."""
    k = []
    frames = ((1, 0, 0, 0), (16, 38, 12, 0), (28, 36, 10, 0), (44, -34, -10, 0), (54, -30, -8, 0),
              (62, -5, 0, 1), (72, 0, 0, 1), (80, 0, 0, 0), (91, 0, 0, 0))
    for (f, look, chest, rub) in frames:
        b = merge(HANG, {"spine": (1, chest * 0.3, 0), "chest": (1, chest * 0.5, 0),
                         "neck": (2, look * 0.45, 0), "head": (-2 + rub * 8, look * 0.55, 0)})
        if rub:
            # Elbow high and out to the side, the hand behind the neck: the
            # old key rubbed the neck through the middle of the skull.
            b.update({"upperarm.R": (-135, -40, 110), "forearm.R": (-130, 0, 0), "hand.R": (-20, 0, 0)})
        sway = 0.008 if look > 0 else (-0.008 if look < 0 else 0.0)
        k.append((f, b, ((sway, 0.0, -0.005), 0.0, look * 0.08, -sway * 100), "rest"))
    # The rub itself: two strokes of the hand while it is up.
    act = _clip(arm, "idle2", k)
    p = arm.pose.bones
    for (f, dx) in ((65, -12), (68, 6), (70, -10)):
        fk(p["forearm.R"], f, x=-130 + dx)
    return "idle2", (1, act)


def anim_fight(arm):
    """The guard, alive: weight settling and lifting, the blade point
    wandering, the shield never dropping."""
    k = []
    for (f, dz, yaw, tip, breath) in ((1, 0.0, 0.0, 0, 0), (9, -0.012, 2.5, -6, 1.5),
                                      (17, -0.004, -2.0, 4, 0.5), (25, -0.014, 1.0, -3, 1.2),
                                      (33, 0.0, 0.0, 0, 0)):
        off, pitch, hy, roll = GUARD_HIPS
        b = merge(GUARD, {"chest": (4 + breath, 10 - yaw, 0),
                          "hand.R": (50 + tip, 0, 0),
                          "forearm.R": (-85 + tip * 0.5, 0, 0)})
        k.append((f, b, ((off[0], off[1], off[2] + dz), pitch, hy + yaw, roll), "guard"))
    return "fight", (1, _clip(arm, "fight", k))


def anim_attack(arm):
    """An overhand cut, 0.8 s. The hips lead the shoulders into it by a couple
    of frames, which is the whole difference between a blow and a wave: wind
    up with the sword cocked behind the head and the body coiled away, then
    uncoil hips-first and bring the blade down diagonally across the front."""
    off, pitch, hy, roll = GUARD_HIPS
    k = [
        (1, GUARD, GUARD_HIPS, "guard"),
        # Cocked: the elbow up and out, the upper arm turned out so the
        # forearm folds back beside the head, not over it. Found by search
        # against `head_clearance` on all three rigs: the old key (-150, 0, 42)
        # put the forearm 98 mm into the skull.
        (7, merge(GUARD, {"spine": (0, -4, 0), "chest": (-4, -10, 0), "head": (-6, 14, 0),
                          "upperarm.R": (-65, 100, 20), "forearm.R": (-130, 0, 0), "hand.R": (30, 0, 0),
                          "upperarm.L": (-40, 40, 14)},
                  # A troll's head is bigger and sits low and forward between
                  # its shoulders: it clubs from out wide instead.
                  {"upperarm.R": (-52, 124, 46), "forearm.R": (-108, 0, 0), "hand.R": (22, 0, 0)} if arm.get("troll") else {}),
         ((0.0, 0.02, -0.05), 2.0, -36.0, 0.0), "guard"),
        (9, merge(GUARD, {"spine": (6, 6, 0), "chest": (2, 2, 0), "head": (-6, 4, 0),
                          "upperarm.R": (-100, 45, 16), "forearm.R": (-85, 0, 0), "hand.R": (40, 0, 0),
                          "upperarm.L": (-36, 40, 14)}),
         ((0.0, -0.02, -0.08), 8.0, -18.0, 0.0), "guard"),
        (11, merge(GUARD, {"spine": (12, 12, 0), "chest": (10, 22, 0), "head": (-14, -8, 0),
                           "upperarm.R": (-62, 0, -8), "forearm.R": (-12, 0, 0), "hand.R": (62, 0, 0),
                           "upperarm.L": (-24, 40, 4), "forearm.L": (-80, 0, 0)}),
         ((0.0, -0.06, -0.10), 13.0, -2.0, 0.0), "guard"),
        (14, merge(GUARD, {"spine": (14, 16, 0), "chest": (10, 28, 0), "head": (-16, -12, 0),
                           "upperarm.R": (-22, 0, -26), "forearm.R": (-22, 0, 0), "hand.R": (70, 0, 0),
                           "upperarm.L": (-20, 40, 2), "forearm.L": (-78, 0, 0)}),
         ((0.0, -0.07, -0.11), 14.0, 2.0, 0.0), "guard"),
        (20, GUARD, GUARD_HIPS, "guard"),
    ]
    return "attack", (1, _clip(arm, "attack", k)), (11 - 1) / 19.0


def anim_attack2(arm):
    """A thrust, 0.9 s: draw the blade back level at the chest, then drive
    the hips forward over a bending front knee and punch it straight out --
    a different line from the cut, so two attacks in a row read as two."""
    k = [
        (1, GUARD, GUARD_HIPS, "guard"),
        (8, merge(GUARD, {"spine": (0, -2, 0), "chest": (-2, -8, 0), "head": (-4, 12, 0),
                          "upperarm.R": (-8, 0, 34), "forearm.R": (-112, 0, 0), "hand.R": (84, 0, 0)}),
         ((0.0, 0.04, -0.05), 0.0, -34.0, 0.0), "guard"),
        (12, merge(GUARD, {"spine": (10, 8, 0), "chest": (10, 14, 0), "head": (-14, -2, 0),
                           "upperarm.R": (-82, 0, 6), "forearm.R": (-8, 0, 0), "hand.R": (88, 0, 0),
                           "upperarm.L": (-22, 40, 6), "forearm.L": (-84, 0, 0)}),
         ((0.0, -0.14, -0.12), 14.0, -8.0, 0.0), "guard"),
        (15, merge(GUARD, {"spine": (10, 8, 0), "chest": (10, 12, 0), "head": (-14, -2, 0),
                           "upperarm.R": (-78, 0, 8), "forearm.R": (-14, 0, 0), "hand.R": (86, 0, 0),
                           "upperarm.L": (-24, 40, 6), "forearm.L": (-84, 0, 0)}),
         ((0.0, -0.13, -0.12), 13.0, -9.0, 0.0), "guard"),
        (22, GUARD, GUARD_HIPS, "guard"),
    ]
    return "attack2", (1, _clip(arm, "attack2", k)), (12 - 1) / 21.0


def anim_hit(arm):
    """A flinch, 0.42 s: the blow lands, the body gives backwards from the
    hips up with the head snapping last, then gathers itself into the guard."""
    k = [
        (1, GUARD, GUARD_HIPS, "guard"),
        (3, merge(GUARD, {"spine": (-8, 12, 0), "chest": (-12, 16, 0), "neck": (-8, 0, 0),
                          "head": (-14, 14, 0),
                          "upperarm.R": (-18, 0, 44), "forearm.R": (-64, 0, 0), "hand.R": (30, 0, 0),
                          "upperarm.L": (-18, 40, 22), "forearm.L": (-70, 0, 0)}),
         ((0.0, 0.06, -0.08), -6.0, -32.0, 3.0), "guard"),
        (6, merge(GUARD, {"spine": (-2, 10, 0), "chest": (-4, 14, 0), "head": (-2, 8, 0),
                          "upperarm.R": (-28, 0, 32), "forearm.R": (-76, 0, 0)}),
         ((0.0, 0.03, -0.075), 2.0, -28.0, 1.0), "guard"),
        (11, GUARD, GUARD_HIPS, "guard"),
    ]
    return "hit", (1, _clip(arm, "hit", k))


def anim_block(arm):
    """Shield up, 0.5 s: the shield arm drives up and out to meet the blow,
    the body drops under it and the head tucks in behind the rim."""
    up = merge(GUARD, {"spine": (8, 4, 0), "chest": (8, 4, 0), "neck": (6, 0, 0), "head": (4, 2, 0),
                       "upperarm.L": (-72, 44, 4), "forearm.L": (-78, 0, 0), "hand.L": (0, 0, 45),
                       "upperarm.R": (-24, 0, 30), "forearm.R": (-96, 0, 0), "hand.R": (40, 0, 0)})
    k = [
        (1, GUARD, GUARD_HIPS, "guard"),
        (4, up, ((0.0, 0.01, -0.10), 9.0, -22.0, 0.0), "guard"),
        (8, up, ((0.0, 0.02, -0.11), 9.0, -22.0, 0.0), "guard"),
        (13, GUARD, GUARD_HIPS, "guard"),
    ]
    return "block", (1, _clip(arm, "block", k))


def anim_death(arm):
    """A fall onto the back, 1.5 s, meant to be held on its last frame. The
    blow rocks the body back, the knees go, and it drops -- hips first, then
    shoulders, then the head, which lands last and rolls to one side. The
    feet never move: they are planted by the IK and the legs straighten
    along the ground as the body goes over them."""
    lie = {"spine": (-4, 0, 0), "chest": (-6, 0, 0), "neck": (-6, 0, 0), "head": (-10, 28, 0),
           "upperarm.L": (-18, 0, -52), "forearm.L": (-30, 0, 0), "hand.L": (0, 0, 0),
           "upperarm.R": (-10, 0, 60), "forearm.R": (-18, 0, 0), "hand.R": (20, 0, 0)}
    k = [
        (1, GUARD, GUARD_HIPS, "guard"),
        (4, merge(GUARD, {"spine": (-10, 12, 0), "chest": (-14, 16, 0), "head": (-18, 16, 0),
                          "upperarm.R": (-16, 0, 50), "forearm.R": (-50, 0, 0),
                          "upperarm.L": (-14, 40, 26), "forearm.L": (-60, 0, 0)}),
         ((0.0, 0.07, -0.08), -8.0, -30.0, 4.0), "guard"),
        (12, merge(HANG, {"spine": (14, 6, 0), "chest": (12, 6, 0), "neck": (10, 0, 0), "head": (14, 6, 0),
                          "upperarm.L": (-6, 0, -12), "upperarm.R": (-4, 0, 14),
                          "forearm.L": (-30, 0, 0), "forearm.R": (-34, 0, 0)}),
         ((0.0, 0.10, -0.30), 18.0, -18.0, 5.0), "guard"),
        (19, merge(lie, {"head": (10, 10, 0), "upperarm.L": (-40, 0, -30), "upperarm.R": (-40, 0, 30)}),
         ((0.0, 0.45, -0.58), -48.0, -10.0, 4.0), "guard"),
        (24, merge(lie, {"head": (-20, 18, 0)}), ((0.0, 0.76, -0.82), -88.0, -6.0, 2.0), "guard"),
        (27, merge(lie, {"head": (-4, 24, 0)}), ((0.0, 0.77, -0.80), -84.0, -6.0, 2.0), "guard"),
        (31, lie, ((0.0, 0.78, -0.83), -89.0, -6.0, 2.0), "guard"),
        (36, lie, ((0.0, 0.78, -0.83), -89.0, -6.0, 2.0), "guard"),
    ]
    end = _clip(arm, "death", k)
    _lay_down_held(arm, lie, (27, 31, 36))
    return "death", (1, end)


def _lay_down_held(arm, lie, frames):
    """Turn the hands on the ground so what they hold lies flat. A hand at
    rest on its back holds a sword with the blade straight up at the sky --
    the thumb side of a fist points up when the arm lies palm-down -- and a
    review found every dead guard's sword and shield standing on end. So the
    right hand is turned until the blade (the grip bone's Y) lies level, and
    the left forearm until the shield's face (the shield bone's Z) is up or
    down. Searched, keyed on the held frames."""
    p = arm.pose.bones
    scene = bpy.context.scene
    last = frames[-1]

    def measure(bone, axis):
        scene.frame_set(last)
        bpy.context.view_layer.update()
        M = arm.pose.bones[bone].matrix.to_3x3()
        return (M @ V(axis)).normalized()
    # First the arms down onto the ground: lie's arms were written against
    # the torso and left the hands a third of a metre up in the air.
    for t in "LR":
        ux, uy, uz = lie["upperarm." + t]
        best = None
        for lower in range(-20, 61, 4):
            for f in frames:
                fk(p["upperarm." + t], f, x=ux + lower, y=uy, z=uz)
            scene.frame_set(last)
            bpy.context.view_layer.update()
            h = min(arm.pose.bones["hand." + t].head.z, arm.pose.bones["hand." + t].tail.z)
            if best is None or abs(h - 0.035) < best[0]:
                best = (abs(h - 0.035), lower)
        for f in frames:
            fk(p["upperarm." + t], f, x=ux + best[1], y=uy, z=uz)
    x, _, z = lie["hand.R"]
    best = None
    for twist in range(-90, 91, 10):
        for f in frames:
            fk(p["hand.R"], f, x=x, y=twist, z=z)
        tilt = abs(measure("grip.R", (0, 1, 0)).z)
        if best is None or tilt < best[0]:
            best = (tilt, twist)
    for f in frames:
        fk(p["hand.R"], f, x=x, y=best[1], z=z)
    fx, _, fz = lie["forearm.L"]
    best = None
    for twist in range(-90, 91, 10):
        for f in frames:
            fk(p["forearm.L"], f, x=fx, y=twist, z=fz)
        flat = abs(measure("shield.L", (0, 0, 1)).z)
        if best is None or flat > best[0]:
            best = (flat, twist)
    for f in frames:
        fk(p["forearm.L"], f, x=fx, y=best[1], z=fz)


def anim_cast(arm):
    """A spell, 1.0 s. Gather: both hands drawn in together before the chest,
    the head bowed over them and the weight settling. Release at 0.58: the
    right arm drives up and forward -- so a staff in it is thrust at the sky
    and an empty hand opens at the target -- the left palm pushes out, the
    chest lifts and the head comes up after it. Then back to standing. Written
    from the plain stance, not the guard, so it reads the same for a wizard
    in a street as for a priest in a fight."""
    gather = merge(HANG, {"spine": (6, 0, 0), "chest": (8, 0, 0), "neck": (8, 0, 0), "head": (10, 0, 0),
                          "upperarm.R": (-34, 0, -18), "forearm.R": (-104, 0, 0), "hand.R": (-10, 0, 0),
                          "upperarm.L": (-34, 0, 18), "forearm.L": (-104, 0, 0), "hand.L": (-10, 0, 0)})
    release = merge(HANG, {"spine": (-4, 0, 0), "chest": (-8, 0, 0), "neck": (-4, 0, 0),
                           "head": (-10, 0, 0),
                           # Arm out in front with the forearm up past level: a
                           # staff in the fist stands straight up, high, and an
                           # empty hand is raised at the target.
                           "upperarm.R": (-78, 0, 8), "forearm.R": (-26, 0, 0), "hand.R": (4, 0, 0),
                           "upperarm.L": (-84, 0, -6), "forearm.L": (-12, 0, 0), "hand.L": (-60, 0, 0)})
    k = [
        (1, HANG, ((0, 0, -0.004), 0, 0, 0), "rest"),
        (6, blend(HANG, gather, 0.7), ((0, 0.01, -0.03), 4, 0, 0), "rest"),
        (11, gather, ((0, 0.015, -0.045), 6, 0, 0), "rest"),
        (13, blend(gather, release, 0.45), ((0, 0.0, -0.03), 2, 0, 0), "rest"),
        (15, release, ((0, -0.02, -0.01), -3, 0, 0), "rest"),
        (19, release, ((0, -0.02, -0.012), -3, 0, 0), "rest"),
        (25, HANG, ((0, 0, -0.004), 0, 0, 0), "rest"),
    ]
    end = _clip(arm, "cast", k)
    _stand_up(arm, "hand.R", release["hand.R"], (15, 19))
    return "cast", (1, end), (15 - 1) / 24.0


def _stand_up(arm, bone, rot, frames):
    """Pitch a hand until what it holds (the grip bone's Y) stands straight
    up on the given frames: a staff thrust at the sky, not leaning out at
    thirty degrees as the written key left it on every rig."""
    p = arm.pose.bones
    scene = bpy.context.scene
    x0, y0, z0 = rot
    best = None
    for dx in range(-80, 81, 4):
        for f in frames:
            fk(p[bone], f, x=x0 + dx, y=y0, z=z0)
        scene.frame_set(frames[-1])
        bpy.context.view_layer.update()
        up = (arm.pose.bones["grip.R"].matrix.to_3x3() @ V((0, 1, 0))).normalized().z
        if best is None or up > best[0]:
            best = (up, dx)
    for f in frames:
        fk(p[bone], f, x=x0 + best[1], y=y0, z=z0)
    return best


def anim_sit(arm):
    """Five seconds seated on a bench: the hips down on a seat 0.46 m high
    (at scale 1, a man's rig), feet planted a pace forward, hands on the
    thighs, breathing -- and halfway through the right hand comes up to the
    mouth with a cup and goes back down."""
    rest = merge(HANG, {"spine": (6, 0, 0), "chest": (4, 0, 0), "neck": (-2, 0, 0), "head": (-4, 0, 0),
                        "upperarm.L": (-34, 0, -8), "upperarm.R": (-34, 0, 8),
                        "forearm.L": (-44, 0, 0), "forearm.R": (-44, 0, 0),
                        "hand.L": (14, 0, 0), "hand.R": (14, 0, 0)})
    sip = merge(rest, {"upperarm.R": (-44, 0, 18), "forearm.R": (-128, 0, 0), "hand.R": (-24, 0, 0),
                       "head": (-12, 0, 0), "neck": (-4, 0, 0), "chest": (1, 0, 0)})
    breathe = merge(rest, {"chest": (2, 0, 0), "spine": (5, 0, 0), "head": (-2, 5, 0)})
    ls = _leg_scale(arm)
    drop = arm.data.bones["hips"].head_local.z - (SEAT * ls + 0.05 * ls)
    STANCES["sit"] = {"L": ((0.020, -0.340 * ls), 8.0, 0.0), "R": ((-0.020, -0.340 * ls), -8.0, 0.0)}
    hips = ((0.0, 0.10 * ls, -drop), -4.0, 0.0, 0.0)
    k = [(1, rest, hips, "sit"), (22, breathe, hips, "sit"), (44, rest, hips, "sit"),
         (58, merge(rest, {"head": (-4, -6, 0)}), hips, "sit"),
         (70, sip, hips, "sit"), (84, sip, hips, "sit"), (96, rest, hips, "sit"),
         (108, breathe, hips, "sit"), (121, rest, hips, "sit")]
    return "sit", (1, _clip(arm, "sit", k))


# The seat the sit is written for, in metres at scale 1 for a man's legs
# (scaled by leg length for the others): the hip joint sits 0.05 m above it.
SEAT = 0.46

# Arms folded across the chest, found by search against each hand's target
# on the far side of the chest and the forearms' clearance of it.
FOLDED = {"upperarm.R": (-30, -60, 30), "forearm.R": (-100, 0, 0), "hand.R": (10, 0, 0),
          "upperarm.L": (-50, 60, -50), "forearm.L": (-100, 0, 0), "hand.L": (10, 0, 0)}


def anim_lean(arm):
    """Four seconds leaning back against a wall: the shoulders on it, the
    hips a hand's breadth off it, arms folded, the left foot crossed over in
    front, the head turning now and then to watch the street."""
    base = merge(HANG, FOLDED, {"spine": (-5, 0, 0), "chest": (-4, 0, 0), "neck": (4, 0, 0), "head": (2, 0, 0)})
    hips = ((0.0, 0.05, -0.012), -4.0, 0.0, 1.5)
    k = [(1, base, hips, "lean"),
         (30, merge(base, {"head": (4, 16, 0), "neck": (4, 8, 0), "chest": (-3, 0, 0)}), hips, "lean"),
         (55, merge(base, {"head": (1, 12, 0), "neck": (3, 6, 0)}), hips, "lean"),
         (75, merge(base, {"head": (0, -8, 0), "neck": (2, -4, 0), "chest": (-5, 0, 0)}), hips, "lean"),
         (97, base, hips, "lean")]
    return "lean", (1, _clip(arm, "lean", k))


def anim_talk(arm):
    """Three seconds of talking: the right hand opening out and back with
    the phrase, the left joining it once, the head nodding and turning a
    little, the weight shifting under it."""
    base = merge(HANG, {"forearm.R": (-58, 0, 0), "upperarm.R": (-14, 0, 6), "hand.R": (-10, 0, 0)})
    a = merge(base, {"upperarm.R": (-26, 0, 16), "forearm.R": (-78, 0, 0), "hand.R": (-30, 0, 0),
                     "head": (4, 4, 0), "neck": (2, 2, 0)})
    b = merge(base, {"upperarm.R": (-20, 0, 24), "forearm.R": (-66, 0, 0), "hand.R": (-44, 0, 0),
                     "upperarm.L": (-16, 0, -18), "forearm.L": (-64, 0, 0), "hand.L": (-30, 0, 0),
                     "head": (-3, -3, 0), "chest": (2, -4, 0)})
    c = merge(base, {"upperarm.R": (-18, 0, 10), "forearm.R": (-70, 0, 0), "hand.R": (-20, 0, 0),
                     "head": (6, 2, 0), "neck": (3, 0, 0)})
    hips = ((0.0, 0.0, -0.004), 0.0, 0.0, 0.0)
    k = [(1, base, hips, "rest"), (12, a, ((0.006, 0, -0.004), 0, 2, -1), "rest"), (24, c, hips, "rest"),
         (38, b, ((-0.006, 0, -0.004), 0, -2, 1), "rest"), (52, a, hips, "rest"), (62, c, hips, "rest"),
         (73, base, hips, "rest")]
    return "talk", (1, _clip(arm, "talk", k))


def anim_carry(arm, name):
    new_action(arm, name)
    pose(arm, 1, CARRY[name])
    pose(arm, 2, CARRY[name])
    if name == "carry_pole":
        # A pole carried is carried upright, on whatever rig.
        _stand_up(arm, "hand.R", CARRY[name]["hand.R"], (1, 2))
    return name, (1, 2)


# --- jump and land ----------------------------------------------------------

def _leg_geometry(arm):
    """Thigh and shin length and the straight-leg hip-to-ankle height of this
    rig, so the knee angles below are the same on a troll as on a woman."""
    b = arm.data.bones
    return (b["thigh.L"].length, b["shin.L"].length,
            b["thigh.L"].head_local.z - b["foot.L"].head_local.z)


def _crouch_drop(arm, knee):
    """How far the hips sink with the feet planted under them for a knee
    flexed `knee` degrees: law of cosines on thigh and shin."""
    l1, l2, D = _leg_geometry(arm)
    return D - math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * math.cos(math.radians(knee)))


def _air_leg(arm, tag, thigh, knee, pitch):
    """One foot, free of the ground: the thigh `thigh` degrees forward of
    vertical (negative is behind it), the knee flexed `knee`. An ankle offset
    from rest as (dx, dy, dz, pitch); y negative is forward."""
    l1, l2, D = _leg_geometry(arm)
    a, k = math.radians(thigh), math.radians(knee)
    fwd = l1 * math.sin(a) + l2 * math.sin(a - k)
    down = l1 * math.cos(a) + l2 * math.cos(a - k)
    return (STANCES["rest"][tag][0][0], -fwd, D - down, pitch)


def _leap_feet(arm, t=1.0):
    """The leap's legs, `t` of the way from standing: the right leg leads
    (thigh 50 forward, knee 75, toes down a little), the left trails (thigh
    15 behind, knee 65, the foot up behind). The knees are over a standing
    leg's at t=0, so the push carries into the pose rather than snapping."""
    return {"R": _air_leg(arm, "R", 50.0 * t, 75.0 * t, -25.0 * t),
            "L": _air_leg(arm, "L", -15.0 * t, 65.0 * t, -35.0 * t)}


def _grounded(dz=0.0, pitch=0.0):
    return {t: (STANCES["rest"][t][0][0], 0.0, dz, pitch) for t in "LR"}


def _air_clip(arm, name, keys):
    """keys: [(frame, bones, hips, feet)] with feet from _leap_feet/_air_leg/_grounded."""
    new_action(arm, name)
    for (f, bones, hips, feet) in keys:
        pose(arm, f, bones, hips, feet=False)
        for t in "LR":
            dx, dy, dz, pitch = feet[t]
            a = rest_ankle(arm, t) + V((dx, dy, dz))
            place(arm, "foot_ik." + t, f, foot_matrix(arm, t, a, pitch, STANCES["rest"][t][1]))
    return keys[-1][0]


# Arms and trunk, written once so jump and land share their poses exactly.
# Positive X on an arm swings it back, negative forward; Z out is + on R.
# The leap: left arm forward and up, right arm back and out (against the
# legs), chest leaning 10 degrees and turned 8 towards the leading right leg,
# the head held level. The right arm is back so a weapon in that hand points
# away from a camera behind the figure.
_AIR = merge(HANG, {"spine": (4, -3, 0), "chest": (6, -5, 0), "neck": (-6, 0, 0), "head": (-10, 0, 0),
                    "upperarm.L": (-70, 0, -25), "forearm.L": (-40, 0, 0),
                    "upperarm.R": (25, 0, 45), "forearm.R": (-30, 0, 0)})
_AIR_HIPS = ((0.0, 0.0, -0.004), 5.0, 0.0, 0.0)
# The idle clip's first key: land ends on it, so the crossfade is a no-op.
_IDLE0 = merge(HANG, {"forearm.L": (-10, 0, 0), "forearm.R": (-12, 0, 0)})
_IDLE0_HIPS = ((0.0, 0.0, -0.004), 0.0, 0.0, 0.0)


def anim_jump(arm):
    """0.29 s, held on its last frame while airborne. Down into a crouch with
    the arms swung back, drive up onto the toes with the arms coming through,
    then the knees draw up and the arms lift forward and out for balance."""
    d = _crouch_drop(arm, 25.0)
    crouch = merge(HANG, {"spine": (12, 0, 0), "chest": (10, 0, 0), "neck": (-4, 0, 0), "head": (-10, 0, 0),
                          "upperarm.R": (42, 0, 10), "upperarm.L": (42, 0, -10),
                          "forearm.R": (-14, 0, 0), "forearm.L": (-14, 0, 0)})
    push = merge(HANG, {"spine": (2, 0, 0), "chest": (2, 0, 0), "head": (-6, 0, 0),
                        "upperarm.R": (-42, 0, 22), "upperarm.L": (-42, 0, -22),
                        "forearm.R": (-20, 0, 0), "forearm.L": (-20, 0, 0)})
    k = [
        (1, crouch, ((0.0, 0.0, -0.004 - d), 8.0, 0.0, 0.0), _grounded()),
        (3, push, ((0.0, 0.0, 0.0), 0.0, 0.0, 0.0), _grounded(0.03, -25.0)),
        (5, blend(push, _AIR, 0.5), ((0.0, 0.0, -0.004), 3.0, 0.0, 0.0), _leap_feet(arm, 0.5)),
        (8, _AIR, _AIR_HIPS, _leap_feet(arm)),
    ]
    return "jump", (1, _air_clip(arm, "jump", k))


def anim_land(arm):
    """0.33 s: from the airborne pose the feet meet the ground, the knees
    take it (30 degrees, hips down), the arms come forward and down, and the
    body rises to the idle stance, which is where the last key sits."""
    d = _crouch_drop(arm, 30.0)
    take = merge(HANG, {"spine": (12, 0, 0), "chest": (10, 0, 0), "neck": (-4, 0, 0), "head": (-10, 0, 0),
                        "upperarm.R": (-30, 0, 22), "upperarm.L": (-30, 0, -22),
                        "forearm.R": (-24, 0, 0), "forearm.L": (-24, 0, 0)})
    deep = ((0.0, 0.0, -0.004 - d), 9.0, 0.0, 0.0)
    k = [
        (1, _AIR, _AIR_HIPS, _leap_feet(arm)),
        # The leading right foot meets the ground first, the left still reaching.
        (2, blend(_AIR, take, 0.35), ((0.0, 0.0, -0.004 - d * 0.25), 6.0, 0.0, 0.0),
         {"R": _grounded()["R"], "L": _air_leg(arm, "L", 8.0, 40.0, -10.0)}),
        (3, blend(_AIR, take, 0.7), ((0.0, 0.0, -0.004 - d * 0.6), 8.0, 0.0, 0.0), _grounded()),
        (5, take, deep, _grounded()),
        (7, blend(take, _IDLE0, 0.55), ((0.0, 0.0, -0.004 - d * 0.3), 4.0, 0.0, 0.0), _grounded()),
        (9, _IDLE0, _IDLE0_HIPS, _grounded()),
    ]
    return "land", (1, _air_clip(arm, "land", k))


# --- kick, backstab, disarm -------------------------------------------------
# Skills of the warrior and the thief. All three start and end on the idle
# clip's first key (as land does) so they cut in and out of any stance.

def _kfeet(arm, thigh, knee, pitch, hz, step=0.0):
    """Right leg raised (see _air_leg), left planted. `hz` is the hips' drop,
    which _air_leg does not know: it measures from a hip at standing height."""
    dx, dy, dz, pt = _air_leg(arm, "R", thigh, knee, pitch)
    return {"R": (dx, dy, dz + hz, pt), "L": _grounded()["L"]}


def anim_kick(arm):
    """A front snap kick with the right leg, 0.58 s. The weight goes onto the
    bent left leg, the right knee chambers to 82 degrees with the shin hanging,
    then the shin snaps straight in two frames and the foot stops at the
    target; the torso leans back 15 degrees against it, fists up in guard. The
    leg folds back through the chamber before it comes down, so the foot never
    simply drops. The sword hand stays above the thigh's line, in front of the
    chest."""
    fists = merge(HANG, {"upperarm.R": (-40, 0, 18), "forearm.R": (-96, 0, 0), "hand.R": (46, 0, 0),
                         "upperarm.L": (-36, 0, -14), "forearm.L": (-100, 0, 0), "hand.L": (0, 0, 0)})

    def torso(back):
        return {"spine": (-back * 0.4, 0, 0), "chest": (-back * 0.35, 0, 0), "neck": (back * 0.2, 0, 0),
                "head": (back * 0.15, 0, 0)}

    # (frame, arm blend towards the fists, back lean, thigh, knee, toes, hips)
    rows = [
        (3, 0.5, -3, 12, 35, -15, ((0.035, 0.0, -0.034), 3.0, 0.0, -2.0)),
        (5, 0.9, 0, 58, 108, -20, ((0.052, 0.0, -0.030), -1.0, 0.0, -3.0)),
        (6, 1.0, 5, 88, 122, -20, ((0.056, 0.015, -0.026), -3.0, 0.0, -3.5)),
        (7, 1.0, 9, 92, 52, 12, ((0.056, 0.03, -0.024), -4.0, 0.0, -3.5)),
        (8, 1.0, 15, 96, 3, 55, ((0.056, 0.045, -0.024), -5.0, 0.0, -3.5)),
        (9, 1.0, 15, 96, 6, 55, ((0.056, 0.045, -0.024), -5.0, 0.0, -3.5)),
        (11, 1.0, 5, 86, 106, -12, ((0.052, 0.02, -0.028), -2.0, 0.0, -3.0)),
        (13, 0.5, 0, 22, 45, -10, ((0.02, 0.0, -0.016), 1.0, 0.0, -1.0)),
    ]
    k = [(1, _IDLE0, _IDLE0_HIPS, _grounded())]
    for (f, a, back, th, kn, pt, hips) in rows:
        k.append((f, merge(blend(_IDLE0, fists, a), torso(back)), hips, _kfeet(arm, th, kn, pt, hips[0][2])))
    k.append((15, _IDLE0, _IDLE0_HIPS, _grounded()))
    return "kick", (1, _air_clip(arm, "kick", k)), (8 - 1) / 14.0


def anim_backstab(arm):
    """A low lunge, 0.75 s. Down into a crouch (knees 35 degrees) and a
    creeping step in with the dagger drawn back at the hip, then the right
    foot goes a long way forward, the hips drop over it and the dagger arm
    drives forward and up under the ribs while the left hand reaches ahead for
    the shoulder. A beat's hold, then back to standing."""
    drop = _crouch_drop(arm, 35.0)
    crouch = merge(HANG, {"spine": (10, -4, 0), "chest": (8, -4, 0), "neck": (-4, 0, 0), "head": (-10, 0, 0),
                          "upperarm.R": (22, 0, 16), "forearm.R": (-78, 0, 0), "hand.R": (40, 0, 0),
                          "upperarm.L": (-42, 0, -10), "forearm.L": (-34, 0, 0), "hand.L": (0, 0, 0)})
    lunge = merge(HANG, {"spine": (14, -6, 0), "chest": (10, -8, 0), "neck": (-8, 4, 0), "head": (-22, 4, 0),
                         "upperarm.R": (-128, 0, 8), "forearm.R": (-14, 0, 0), "hand.R": (70, 0, 0),
                         "upperarm.L": (-92, 0, -14), "forearm.L": (-12, 0, 0), "hand.L": (0, 0, 0)})
    drive = merge(lunge, {"upperarm.R": (-134, 0, 6), "forearm.R": (-8, 0, 0), "chest": (10, -10, 0)})
    deep = -0.20

    def feet(r_dy, l_dy, r_dz=0.0, l_dz=0.0, l_pitch=0.0):
        return {"R": (STANCES["rest"]["R"][0][0], r_dy, r_dz, 0.0),
                "L": (STANCES["rest"]["L"][0][0], l_dy, l_dz, l_pitch)}

    k = [
        (1, _IDLE0, _IDLE0_HIPS, _grounded()),
        (4, crouch, ((0.0, 0.0, -0.004 - drop), 12.0, 6.0, 0.0), feet(0.04, -0.04)),
        # Creeping step: the right foot comes through, low, the weight on the left.
        (7, blend(crouch, lunge, 0.35), ((0.0, -0.05, -0.004 - drop * 1.1), 12.0, 10.0, 0.0),
         feet(-0.30, 0.06, 0.07)),
        (9, blend(crouch, lunge, 0.8), ((0.0, -0.10, -0.004 - drop - 0.07), 14.0, 12.0, 0.0),
         feet(-0.58, 0.28)),
        (10, lunge, ((0.0, -0.14, -0.004 - drop - 0.10), 14.0, 14.0, 0.0), feet(-0.66, 0.40)),
        (12, drive, ((0.0, -0.15, -0.004 - drop - 0.10), 15.0, 15.0, 0.0), feet(-0.66, 0.40)),
        (15, blend(drive, _IDLE0, 0.55), ((0.0, -0.06, -0.004 - drop * 0.8), 8.0, 6.0, 0.0),
         feet(-0.25, 0.14)),
        (19, _IDLE0, _IDLE0_HIPS, _grounded()),
    ]
    return "backstab", (1, _air_clip(arm, "backstab", k)), (10 - 1) / 18.0


def anim_disarm(arm):
    """A bind and flick, 0.58 s. The blade comes in to the guard, the hand
    circles inward and down with the forearm turning under it (the bind, on
    the opponent's blade), then the wrist and elbow flick it up and out to the
    right as the hips turn 20 degrees with it. Back to standing."""
    guard = merge(HANG, {"spine": (3, 4, 0), "chest": (3, 6, 0), "neck": (-3, 2, 0), "head": (-5, 2, 0),
                         "upperarm.R": (-38, 0, 14), "forearm.R": (-88, 0, 0), "hand.R": (48, 0, 0),
                         "upperarm.L": (-30, 0, -12), "forearm.L": (-90, 0, 0), "hand.L": (0, 0, 20)})
    bind = merge(guard, {"spine": (6, 8, 0), "chest": (6, 12, 0), "head": (-6, 4, 0),
                         "upperarm.R": (-48, 0, -10), "forearm.R": (-62, -45, 0), "hand.R": (78, 0, 0)})
    flick = merge(guard, {"spine": (2, -14, 0), "chest": (0, -22, 0), "head": (-6, -10, 0),
                          "upperarm.R": (-46, 0, 46), "forearm.R": (-72, 32, 0), "hand.R": (8, 0, 0),
                          "upperarm.L": (-26, 0, -8)})
    k = [
        (1, _IDLE0, _IDLE0_HIPS, _grounded()),
        (3, blend(_IDLE0, guard, 0.9), ((0.0, 0.0, -0.02), 3.0, 8.0, 0.0), _grounded()),
        (5, blend(guard, bind, 0.6), ((0.0, 0.01, -0.03), 5.0, 14.0, 0.0), _grounded()),
        (6, bind, ((0.0, 0.01, -0.035), 6.0, 20.0, 0.0), _grounded()),
        (7, blend(bind, flick, 0.6), ((0.0, -0.01, -0.03), 4.0, -4.0, 0.0), _grounded()),
        (8, flick, ((0.0, -0.02, -0.025), 2.0, -20.0, 0.0), _grounded()),
        (10, flick, ((0.0, -0.02, -0.025), 2.0, -22.0, 0.0), _grounded()),
        (12, blend(flick, _IDLE0, 0.6), ((0.0, 0.0, -0.012), 1.0, -8.0, 0.0), _grounded()),
        (15, _IDLE0, _IDLE0_HIPS, _grounded()),
    ]
    return "disarm", (1, _air_clip(arm, "disarm", k)), (8 - 1) / 14.0


# --- jog, sprint, sidestep, backpedal, turn ---------------------------------
#
# Natural speeds are what the viewer matches playback to (stride over clip
# length, scaled by leg length like walk and run): jog 4.8 m/s, the player's
# default pace; sprint 9 m/s. The sidesteps and the backpedal are for a body
# whose facing is held, so their torso stays square to the front.

def _gait_clip(arm, name, n, g, upper):
    g.key()
    upper_locomotion(arm, n, gait=g, **upper)
    ret = dict(stride=g.stride, stance=g.beta)
    if g.dir is not None:
        ret["direction"] = list(g.dir)
    return name, (1, n + 1), ret


def anim_jog(arm):
    """16 frames, 3.2 m a cycle: 4.8 m/s at 3 steps a second, a short
    flight between steps, the heel kicked up early, 8 degrees of lean from
    the hips and the arms pumping at about 80 to 100 degrees."""
    new_action(arm, "jog")
    n = 16
    g = Gait(arm, n, stride=3.20 * _leg_scale(arm), stance=0.32, lift=0.22, pitch_strike=12.0,
             pitch_off=-42.0, lean=8.0, sway=0.012, yaw=6.0, roll=3.0, bob=0.022, aft=0.10, reach=0.985, kick=0.55)
    return _gait_clip(arm, "jog", n, g, dict(swing=36.0, elbow=56.0, lean_chest=2.0, counter=7.0,
                                             arm_out=7.0, hand=-8.0))


def anim_sprint(arm):
    """11 frames, 4.1 m a cycle: 9 m/s at 4.4 steps a second. Long flight,
    high knees, 13 degrees of lean taken at the ankle (the feet land further
    behind the hips, the chest does not fold), arms driving hard with the
    hands loose."""
    new_action(arm, "sprint")
    n = 11
    g = Gait(arm, n, stride=4.10 * _leg_scale(arm), stance=0.26, lift=0.40, pitch_strike=6.0,
             pitch_off=-50.0, lean=13.0, sway=0.008, yaw=8.0, roll=3.0, bob=0.03, aft=0.10, reach=0.985, kick=0.50)
    return _gait_clip(arm, "sprint", n, g, dict(swing=48.0, elbow=68.0, lean_chest=0.0, counter=10.0,
                                                arm_out=8.0, hand=-4.0))


def _strafe(arm, name, sx):
    """`sx` is the side the body goes to: +1 left. The planted feet run the
    other way under it, flat; the foot in the air carries forward past the
    planted one and well off the ground, so they cross one in front of the
    other without meeting. Torso square to the front, arms held ready."""
    new_action(arm, name)
    n = 15
    g = Gait(arm, n, stride=2.65 * _leg_scale(arm), stance=0.32, lift=0.13, pitch_strike=0.0,
             pitch_off=0.0, lean=3.0, sway=0.0, yaw=1.5, roll=4.0 * sx, bob=0.012, aft=0.0, kick=0.85,
             direction=(-float(sx), 0.0), cross=0.24 * _leg_scale(arm))
    return _gait_clip(arm, name, n, g, dict(swing=9.0, elbow=62.0, lean_chest=1.0, counter=2.0,
                                            arm_out=6.0, hand=0.0))


def anim_strafe_l(arm):
    return _strafe(arm, "strafe_l", 1)


def anim_strafe_r(arm):
    return _strafe(arm, "strafe_r", -1)


def anim_back(arm):
    """14 frames, 1.87 m a cycle: 3.2 m/s backwards, short steps landing on
    the toe and the heel only coming down after, the weight kept forward."""
    new_action(arm, "back")
    n = 14
    g = Gait(arm, n, stride=1.87 * _leg_scale(arm), stance=0.55, lift=0.10, pitch_strike=-16.0,
             pitch_off=-26.0, lean=4.0, sway=0.014, yaw=4.0, roll=3.0, bob=0.0, aft=0.0, kick=0.85,
             direction=(0.0, -1.0))
    return _gait_clip(arm, "back", n, g, dict(swing=16.0, elbow=48.0, lean_chest=1.0, counter=3.0,
                                              arm_out=5.0, hand=0.0))


# A turn in place. The clip animates the body in the figure's own frame: the
# FIGURE'S ROOT is what turns, by TURN_DEG * _smoothstep(t / duration) -- the
# viewer applies that to the group while the clip plays, positive to the left.
# What the clip adds is everything a root turn on its own lacks: the hips
# lead it, the head looks into it ahead of the body, and the feet stay where
# they were on the ground (so they appear to counter-rotate in the figure's
# frame) until each is lifted and set down again facing the new way. It ends
# on idle's first key, so after the turn the figure is at rest, rotated.
TURN_DEG = 90.0
TURN_FRAMES = 13


def _turn(arm, name, sg):
    new_action(arm, name)
    n = TURN_FRAMES
    hb = arm.data.bones
    lead, second = ("L", "R") if sg > 0 else ("R", "L")
    # (lift, land) as a share of the clip, per foot.
    steps = {lead: (0.08, 0.55), second: (0.42, 0.90)}
    base = {}
    for t in "LR":
        (dx, dy), yaw0, _ = STANCES["rest"][t]
        A = rest_ankle(arm, t)
        base[t] = (A, V((A.x + dx, A.y + dy)), yaw0)
    psi_end = sg * TURN_DEG
    for f in range(n + 1):
        u = f / n
        frame = f + 1
        psi = psi_end * _smoothstep(u)
        left = sg * (TURN_DEG * (1.0 - _smoothstep(u)))         # degrees still to turn, signed
        bump = math.sin(math.pi * u)
        bones = merge(_IDLE0, {"chest": (0, -sg * 5.0 * bump, 0), "spine": (0, -sg * 2.0 * bump, 0),
                               "neck": (0, left * 0.30, 0), "head": (0, left * 0.30, 0)})
        pose(arm, frame, bones, ((0.0, 0.0, -0.004 - 0.015 * bump), 2.0 * bump, sg * 16.0 * bump, 0.0),
             feet=False)
        for t in "LR":
            A, P0, yaw0 = base[t]
            lift, land = steps[t]
            s = _smoothstep((u - lift) / (land - lift))
            P1 = V((P0.x * math.cos(math.radians(psi_end)) - P0.y * math.sin(math.radians(psi_end)),
                    P0.x * math.sin(math.radians(psi_end)) + P0.y * math.cos(math.radians(psi_end))))
            world = P0 + (P1 - P0) * s
            wyaw = yaw0 + psi_end * s
            c, sn = math.cos(math.radians(-psi)), math.sin(math.radians(-psi))
            body = V((world.x * c - world.y * sn, world.x * sn + world.y * c, A.z + 0.07 * math.sin(math.pi * s)))
            place(arm, "foot_ik." + t, frame, foot_matrix(arm, t, body, 0.0, wyaw - psi))
    return name, (1, n + 1)


def anim_turn_l(arm):
    return _turn(arm, "turn_l", 1)


def anim_turn_r(arm):
    return _turn(arm, "turn_r", -1)


NEW_LOCOMOTION = ("jog", "sprint", "strafe_l", "strafe_r", "back")

# --- casts: a gesture for each family of spell --------------------------------
#
# `cast` stays as it was (the fallback for the families with no gesture of
# their own, and the pose motion.js lays over a priest at his prayers). These
# four are the same second long and release at the same frame, so the page
# stretches any of them to the game's contactIn with the one constant
# (people.js HIT_FRAME): 1.0 s of 24 frames, the spell leaves on frame 15.
# Every key is a whole body -- the weight moves through the hips and the
# feet, which are placed as targets like jump's and planted unless a clip
# steps -- so no clip is an arm waving over a statue.

CAST_RELEASE = 15


def _foot(arm, tag, dx=0.0, dy=0.0, dz=0.0, toes=0.0, yaw=None):
    """One foot's target as an offset from rest (dy negative is forward).
    `toes` rolls the foot that many degrees up onto the ball: the ankle rises
    and comes forward about the ball, which stays where it was, so a foot on
    its toes is still on the floor and not hanging from the hip."""
    b = arm.data.bones["foot." + tag]
    rel = b.head_local - b.tail_local
    phi = math.radians(toes)
    y = rel.y * math.cos(phi) - rel.z * math.sin(phi)
    z = rel.y * math.sin(phi) + rel.z * math.cos(phi)
    return (STANCES["rest"][tag][0][0] + dx, dy + (y - rel.y), dz + (z - rel.z), -toes,
            STANCES["rest"][tag][1] if yaw is None else yaw)


def _hunch(arm):
    """How far forward the trunk leans in this rig's rest pose, in degrees
    (hips joint to the base of the neck): about nothing for a man, a good
    deal for a troll, whose hunch is built into the rest pose."""
    b = arm.data.bones
    v = b["neck"].head_local - b["hips"].head_local
    return math.degrees(math.atan2(-v.y, v.z))


def _fit(arm, bones):
    """A pose written for a man, for this rig: a hunched trunk starts bent, so
    the lean the clip adds is halved (a troll at the full 20 degrees is bent
    double), and an arm raised in front goes up the rest of the way to be
    level in the world, not level with the chest it hangs from."""
    h = _hunch(arm)
    if h < 3.0:
        return bones
    out = dict(bones)
    added = 0.0
    for n in ("spine", "chest"):
        x, y, z = out.get(n, (0, 0, 0))
        added += x
        out[n] = (x * 0.5, y, z)
    for n, side in (("upperarm.L", -1), ("upperarm.R", 1)):
        x, y, z = out.get(n, (0, 0, 0))
        if x < -30:
            k = min(1.0, (-x - 30) / 60.0)
            # The arms hang behind a troll's shoulder line and come forward
            # converging: out to the sides they go as well, or they cross.
            out[n] = (x - (h - 0.5 * max(added, 0.0)) * k, y + side * 0.3 * h * k, z)
    return out


def _cast_clip(arm, name, keys):
    """keys: [(frame, bones, hips, feet)], feet from `_foot` per side."""
    new_action(arm, name)
    for (f, bones, hips, feet) in keys:
        pose(arm, f, _fit(arm, bones), hips, feet=False)
        for t in "LR":
            dx, dy, dz, pitch, yaw = feet[t]
            place(arm, "foot_ik." + t, f, foot_matrix(arm, t, rest_ankle(arm, t) + V((dx, dy, dz)), pitch, yaw))
    return keys[-1][0]


def _hips(arm, x=0.0, y=0.0, knee=None, lead="L", feet=None, pitch=0.0, yaw=0.0, roll=0.0, rise=0.0):
    """The hips as (offset, pitch, yaw, roll), sunk or lifted to where the
    `lead` leg bends its knee `knee` degrees given where that foot stands
    (law of cosines on thigh and shin, as `_crouch_drop`), so a lunge sits
    down onto its legs and a rise onto the toes does not stretch them. With no
    `knee` the hips ride `rise` above the standing height. y is back."""
    if knee is None:
        return ((x, y, -0.004 + rise), pitch, yaw, roll)
    l1, l2, D = _leg_geometry(arm)
    hip = arm.data.bones["thigh." + lead].head_local
    dx, dy, dz, _, _ = feet[lead]
    a = rest_ankle(arm, lead) + V((dx, dy, dz))
    d2 = l1 * l1 + l2 * l2 + 2 * l1 * l2 * math.cos(math.radians(knee))
    h2 = (hip.x + x - a.x) ** 2 + (hip.y + y - a.y) ** 2
    z = a.z + math.sqrt(max(d2 - h2, 0.0))
    return ((x, y, z - hip.z), pitch, yaw, roll)


def _rest_feet(arm):
    return {t: _foot(arm, t) for t in "LR"}


def _aim_fist(arm, aims):
    """Turn the right wrist on each given frame until the line through the
    fist (grip.R's Y, which is the line of a staff) points along `dir`: what
    a staff does in a cast is the point of a cast, and a written wrist angle
    left it at thirty degrees to whatever was meant on every rig. The least
    wrist that gets there."""
    p = arm.pose.bones
    scene = bpy.context.scene
    for frame, want in aims.items():
        want = V(want).normalized()
        best = None
        for x in range(-90, 91, 6):
            for y in range(-72, 73, 12):
                fk(p["hand.R"], frame, x=x, y=y, z=0)
                scene.frame_set(frame)
                bpy.context.view_layer.update()
                got = (arm.pose.bones["grip.R"].matrix.to_3x3() @ V((0, 1, 0))).normalized()
                cost = math.degrees(got.angle(want)) + 0.05 * (abs(x) + abs(y))
                if best is None or cost < best[0]:
                    best = (cost, x, y)
        fk(p["hand.R"], frame, x=best[1], y=best[2], z=0)


# Right hand, in the figure's frame: forward is -Y, up +Z. The staff leans
# forward 30 degrees from the vertical when it points at something: held
# level, the metre of it behind the fist would be through the chest.
UP = (0.0, 0.0, 1.0)
AT_IT = (0.0, -0.55, 0.85)

# The first and last key of every cast: the stance a caster with a staff
# idles in (CARRY's pole, the forearm level and the staff standing up) so
# the crossfade with the idle has no arm to swing, and so the staff does not
# swing forward through the opening frames, as it did from a hanging hand.
# With nothing in the fist it reads as a hand held ready.
HANG_STAFF = merge(HANG, CARRY["carry_pole"])


def anim_cast_thrust(arm):
    """Fire, missile, acid. The weight sinks back onto the left leg with both
    fists drawn in to the ribs and the chest leaning away (frames 1-9); the
    right foot comes through, the hips and the shoulders after it, and both
    hands drive out at chest height with the body behind them on the front
    knee (15, the release); the arms carry on a hand's breadth past it, hold
    there while the energy goes, and the foot comes back (25). A staff in the
    right hand is stood up in the load, brought forward as the arms drive,
    and stood up again."""
    rest = _rest_feet(arm)
    load_b = merge(HANG, {"spine": (-5, -6, 0), "chest": (-6, -8, 0), "neck": (5, 0, 0), "head": (2, 6, 0),
                          "upperarm.R": (22, 0, 22), "forearm.R": (-118, 0, 0), "hand.R": (0, 0, 0),
                          "upperarm.L": (22, 0, -22), "forearm.L": (-118, 0, 0), "hand.L": (0, 0, 0)})
    step_b = merge(load_b, {"spine": (2, 0, 0), "chest": (2, -2, 0), "neck": (-2, 0, 0), "head": (-4, 2, 0),
                            "upperarm.R": (-24, 0, 14), "forearm.R": (-96, 0, 0),
                            "upperarm.L": (-24, 0, -14), "forearm.L": (-96, 0, 0)})
    # The arms are written against a trunk that is leaning 20 degrees forward
    # by now: 104 off the vertical is level with the shoulders. The hips have
    # turned 12 degrees to bring the right side through, and the shoulders
    # turn back against them, so both hands are pointed at the target.
    push_b = merge(HANG, {"spine": (6, -5, 0), "chest": (7, -7, 0), "neck": (-7, -4, 0), "head": (-10, -4, 0),
                          "upperarm.R": (-104, 10, -2), "forearm.R": (-6, 0, 0), "hand.R": (0, 0, 0),
                          "upperarm.L": (-106, -10, 2), "forearm.L": (-6, 0, 0), "hand.L": (-62, 0, 0)})
    over_b = merge(push_b, {"spine": (9, -5, 0), "chest": (9, -7, 0), "neck": (-8, -4, 0), "head": (-11, -4, 0),
                            "upperarm.R": (-108, 11, -4), "forearm.R": (-2, 0, 0),
                            "upperarm.L": (-110, -11, 4), "forearm.L": (-2, 0, 0)})
    ease_b = merge(over_b, {"spine": (6, 2, 0), "chest": (6, 3, 0), "neck": (-4, 0, 0), "head": (-6, 0, 0),
                            "upperarm.R": (-52, 0, 6), "forearm.R": (-40, 0, 0),
                            "upperarm.L": (-54, 0, -6), "forearm.L": (-40, 0, 0)})
    load_f = {"L": _foot(arm, "L"), "R": _foot(arm, "R")}
    swing_f = {"L": _foot(arm, "L", toes=6), "R": _foot(arm, "R", dy=-0.20, dz=0.07)}
    lunge_f = {"L": _foot(arm, "L", dy=0.02, toes=16, yaw=22), "R": _foot(arm, "R", dy=-0.36, yaw=-8)}
    carry_f = {"L": _foot(arm, "L", dy=0.02, toes=14, yaw=22), "R": _foot(arm, "R", dy=-0.36, yaw=-8)}
    back_f = {"L": _foot(arm, "L", toes=4), "R": _foot(arm, "R", dy=-0.16, dz=0.04)}
    k = [
        (1, HANG_STAFF, ((0, 0, -0.004), 0, 0, 0), rest),
        (5, blend(HANG_STAFF, load_b, 0.55), _hips(arm, x=0.015, y=0.03, knee=14, lead="L", feet=load_f, pitch=-1.5, yaw=-3), load_f),
        (9, load_b, _hips(arm, x=0.045, y=0.075, knee=34, lead="L", feet=load_f, pitch=-4, yaw=-9), load_f),
        (12, step_b, _hips(arm, x=0.02, y=0.0, knee=38, lead="L", feet=swing_f, pitch=1, yaw=4), swing_f),
        (15, push_b, _hips(arm, x=-0.01, y=-0.17, knee=44, lead="R", feet=lunge_f, pitch=6, yaw=12), lunge_f),
        (18, over_b, _hips(arm, x=-0.01, y=-0.20, knee=46, lead="R", feet=carry_f, pitch=8, yaw=13), carry_f),
        (21, ease_b, _hips(arm, x=-0.005, y=-0.10, knee=30, lead="R", feet=back_f, pitch=5, yaw=6), back_f),
        (25, HANG_STAFF, ((0, 0, -0.004), 0, 0, 0), rest),
    ]
    end = _cast_clip(arm, "cast_thrust", k)
    _aim_fist(arm, {1: UP, 5: UP, 9: UP, 12: (0.0, -0.3, 0.95), 15: AT_IT, 18: AT_IT, 21: UP, 25: UP})
    return "cast_thrust", (1, end), (CAST_RELEASE - 1) / 24.0


def anim_cast_overhead(arm):
    """Lightning, quake. A dip, then the whole body springs up onto its toes
    as the right arm goes to the sky and the left opens for balance, the back
    arching and the face going up after the hand (frames 1-11); the arm
    cracks down and forward as the heels drop and the knees take the weight
    (15, the release, the hand out in front and low); then it rides on down
    and the body comes up out of the crouch (25)."""
    rest = _rest_feet(arm)
    dip_b = merge(HANG, {"spine": (9, 0, 0), "chest": (8, 0, 0), "neck": (-2, 0, 0), "head": (-4, 0, 0),
                         "upperarm.R": (30, 0, 14), "forearm.R": (-30, 0, 0),
                         "upperarm.L": (30, 0, -14), "forearm.L": (-30, 0, 0)})
    rise_b = merge(HANG, {"spine": (0, -4, 0), "chest": (-2, -4, 0), "neck": (-4, 0, 0), "head": (-8, 0, 0),
                          "upperarm.R": (-112, 0, -6), "forearm.R": (-30, 0, 0),
                          "upperarm.L": (-30, 0, -40), "forearm.L": (-22, 0, 0)})
    top_b = merge(HANG, {"spine": (-6, -5, 0), "chest": (-12, -6, 0), "neck": (-10, 0, 0), "head": (-18, 0, 0),
                         "upperarm.R": (-170, 0, -12), "forearm.R": (-8, 0, 0),
                         "upperarm.L": (8, 0, -58), "forearm.L": (-16, 0, 0), "hand.L": (-10, 0, 0)})
    strike_b = merge(HANG, {"spine": (10, 6, 0), "chest": (9, 8, 0), "neck": (-4, 0, 0), "head": (-10, 0, 0),
                            "upperarm.R": (-106, 0, 0), "forearm.R": (-8, 0, 0),
                            "upperarm.L": (22, 0, -24), "forearm.L": (-40, 0, 0)})
    through_b = merge(strike_b, {"spine": (14, 6, 0), "chest": (12, 8, 0), "neck": (-6, 0, 0), "head": (-12, 0, 0),
                                 "upperarm.R": (-72, 0, 0), "forearm.R": (-16, 0, 0),
                                 "upperarm.L": (30, 0, -18)})
    dip_f = rest
    toe_f = {"L": _foot(arm, "L", toes=26), "R": _foot(arm, "R", toes=26)}
    drop_f = {"L": _foot(arm, "L", dy=-0.05, yaw=14), "R": _foot(arm, "R", dy=-0.05, yaw=-14)}
    k = [
        (1, HANG_STAFF, ((0, 0, -0.004), 0, 0, 0), rest),
        (4, dip_b, _hips(arm, y=0.04, knee=30, lead="L", feet=rest, pitch=4), dip_f),
        (8, rise_b, _hips(arm, y=0.0, rise=0.05, pitch=-1), blend_feet(arm, rest, toe_f, 0.6)),
        (11, top_b, _hips(arm, y=-0.01, rise=0.085, pitch=-3), toe_f),
        (12, top_b, _hips(arm, y=-0.01, rise=0.085, pitch=-3), toe_f),
        (15, strike_b, _hips(arm, y=-0.06, knee=42, lead="L", feet=drop_f, pitch=6, yaw=6), drop_f),
        (19, through_b, _hips(arm, y=-0.06, knee=52, lead="L", feet=drop_f, pitch=8, yaw=6), drop_f),
        (25, HANG_STAFF, ((0, 0, -0.004), 0, 0, 0), rest),
    ]
    end = _cast_clip(arm, "cast_overhead", k)
    _aim_fist(arm, {1: UP, 4: UP, 8: UP, 11: UP, 12: UP, 15: AT_IT, 19: (0.0, -0.4, 0.9), 22: UP, 25: UP})
    return "cast_overhead", (1, end), (CAST_RELEASE - 1) / 24.0


def blend_feet(arm, a, b, t):
    return {tag: tuple(x + (y - x) * t for x, y in zip(a[tag], b[tag])) for tag in "LR"}


def anim_cast_sweep(arm):
    """Colour spray, burning hands, breath. A small turn away first, the
    shoulders giving a breath of room (frames 1-4); then the right arm is
    drawn across the body to the left shoulder and the trunk twists after it,
    the weight on the left leg, and coils one notch further (5-11); then the
    trunk unwinds through the front and the arm goes with it in a wide flat
    arc at shoulder height, the elbow soft all the way and the wrist trailing
    behind the forearm until it whips through, passing the line to the target
    on frame 15 -- the release -- and carrying on out to the right (19) as the
    weight crosses to the right foot, then easing back (22). The left arm
    swings against it."""
    rest = _rest_feet(arm)
    back_b = merge(HANG, {"spine": (2, -4, 0), "chest": (2, -5, 0), "neck": (0, 3, 0), "head": (-1, 4, 0),
                          "upperarm.R": (-14, 8, 10), "forearm.R": (-34, 0, 0), "hand.R": (0, 0, 0),
                          "upperarm.L": (-2, 0, -8), "forearm.L": (-20, 0, 0)})
    wind_b = merge(HANG, {"spine": (4, 16, 0), "chest": (4, 22, 0), "neck": (2, -14, 0), "head": (-2, -20, 0),
                          "upperarm.R": (-74, -38, 0), "forearm.R": (-84, 0, 0), "hand.R": (0, 0, 0),
                          "upperarm.L": (-8, 0, -34), "forearm.L": (-30, 0, 0), "hand.L": (-10, 0, 0)})
    coil_b = merge(wind_b, {"spine": (5, 21, 0), "chest": (5, 29, 0), "neck": (2, -20, 0), "head": (-2, -26, 0),
                            "upperarm.R": (-78, -46, 0), "forearm.R": (-96, 0, 0), "hand.R": (0, 0, -12),
                            "upperarm.L": (-6, 0, -40), "forearm.L": (-34, 0, 0)})
    cross_b = merge(wind_b, {"spine": (4, 8, 0), "chest": (5, 10, 0), "neck": (0, -8, 0), "head": (-3, -10, 0),
                             "upperarm.R": (-86, -14, 0), "forearm.R": (-46, 0, 0), "hand.R": (0, 0, -22),
                             "upperarm.L": (4, 0, -42), "forearm.L": (-30, 0, 0)})
    fire_b = merge(HANG, {"spine": (6, -4, 0), "chest": (6, -4, 0), "neck": (-2, 4, 0), "head": (-5, 6, 0),
                          "upperarm.R": (-88, 14, 0), "forearm.R": (-24, 0, 0), "hand.R": (-20, 0, 8),
                          "upperarm.L": (14, 0, -52), "forearm.L": (-48, 0, 0)})
    out_b = merge(HANG, {"spine": (6, -14, 0), "chest": (6, -20, 0), "neck": (-2, 12, 0), "head": (-6, 16, 0),
                         "upperarm.R": (-86, 62, 0), "forearm.R": (-20, 0, 0), "hand.R": (-20, 0, 10),
                         "upperarm.L": (22, 0, -26), "forearm.L": (-60, 0, 0)})
    ease_b = merge(out_b, {"spine": (4, -8, 0), "chest": (4, -10, 0), "neck": (0, 6, 0), "head": (-3, 8, 0),
                           "upperarm.R": (-56, 46, 0), "forearm.R": (-34, 0, 0),
                           "upperarm.L": (10, 0, -14), "forearm.L": (-30, 0, 0)})
    left_f = {"L": _foot(arm, "L", dy=-0.04, yaw=12), "R": _foot(arm, "R", dy=0.05, toes=8, yaw=-20)}
    right_f = {"L": _foot(arm, "L", dy=0.04, toes=8, yaw=24), "R": _foot(arm, "R", dy=-0.08, yaw=-16)}
    half_f = blend_feet(arm, rest, left_f, 0.5)
    k = [
        (1, HANG_STAFF, ((0, 0, -0.004), 0, 0, 0), rest),
        (3, blend(HANG_STAFF, back_b, 1.0), _hips(arm, x=-0.008, knee=8, lead="R", feet=rest, yaw=-4, roll=-1), rest),
        (6, blend(HANG_STAFF, wind_b, 0.6), _hips(arm, x=0.03, knee=20, lead="L", feet=blend_feet(arm, rest, left_f, 0.7), yaw=9),
         blend_feet(arm, rest, left_f, 0.7)),
        (9, wind_b, _hips(arm, x=0.05, y=0.02, knee=30, lead="L", feet=left_f, pitch=2, yaw=15, roll=3), left_f),
        (11, coil_b, _hips(arm, x=0.058, y=0.025, knee=33, lead="L", feet=left_f, pitch=3, yaw=19, roll=4), left_f),
        (13, cross_b, _hips(arm, x=0.0, knee=34, lead="L", feet=blend_feet(arm, left_f, right_f, 0.5), pitch=3, yaw=0, roll=0),
         blend_feet(arm, left_f, right_f, 0.5)),
        (15, fire_b, _hips(arm, x=-0.035, y=-0.03, knee=36, lead="R", feet=right_f, pitch=4, yaw=-10, roll=-3), right_f),
        (19, out_b, _hips(arm, x=-0.045, y=-0.04, knee=36, lead="R", feet=right_f, pitch=4, yaw=-18, roll=-3), right_f),
        (22, ease_b, _hips(arm, x=-0.02, knee=20, lead="R", feet=blend_feet(arm, right_f, rest, 0.5), pitch=2, yaw=-8),
         blend_feet(arm, right_f, rest, 0.5)),
        (25, HANG_STAFF, ((0, 0, -0.004), 0, 0, 0), rest),
    ]
    end = _cast_clip(arm, "cast_sweep", k)
    _aim_fist(arm, {1: UP, 3: UP, 6: UP, 9: UP, 11: UP, 13: UP, 15: AT_IT, 19: AT_IT, 22: UP, 25: UP})
    return "cast_sweep", (1, end), (CAST_RELEASE - 1) / 24.0


def anim_cast_pray(arm):
    """Heal, bless, sanctuary, the wards. The hands rise and meet at the breast
    with the head bowed over them and the knees giving (frames 1-9); the whole
    body gathers one breath further in, the hands drawn to the chest, the head
    lower (12, the anticipation); then the elbows lead the arms up and out, the
    palms turning to the sky, and at the release (15) they are open and the
    chest lifted with the gaze following the hands up; they rise a little
    further and the head goes back (19) before everything settles (25). The
    elbows are never straight and the wrists lead the hands, which arrive a
    beat after them. A staff in the right hand stays upright: it is held, not
    wielded."""
    rest = _rest_feet(arm)
    reach_b = merge(HANG, {"spine": (4, 0, 0), "chest": (4, 0, 0), "neck": (6, 0, 0), "head": (8, 0, 0),
                           "upperarm.R": (-18, 0, -8), "forearm.R": (-72, 0, 0), "hand.R": (12, 0, 0),
                           "upperarm.L": (-18, 0, 8), "forearm.L": (-72, 0, 0), "hand.L": (12, 0, 0)})
    bow_b = merge(HANG, {"spine": (7, 0, 0), "chest": (8, 0, 0), "neck": (10, 0, 0), "head": (14, 0, 0),
                         "upperarm.R": (-30, 0, -20), "forearm.R": (-108, 0, 0), "hand.R": (-8, 0, 0),
                         "upperarm.L": (-30, 0, 20), "forearm.L": (-108, 0, 0), "hand.L": (-8, 0, 0)})
    # The gather: a breath held in, the hands pressed in and the head lower.
    still_b = merge(bow_b, {"spine": (10, 0, 0), "chest": (11, 0, 0), "neck": (12, 0, 0), "head": (18, 0, 0),
                            "upperarm.R": (-26, 0, -24), "forearm.R": (-114, 0, 0), "hand.R": (-4, 0, 0),
                            "upperarm.L": (-26, 0, 24), "forearm.L": (-114, 0, 0), "hand.L": (-4, 0, 0)})
    # The elbows go first and the hands are still turned in: the wrists lead.
    lift_b = merge(HANG, {"spine": (0, 0, 0), "chest": (-4, 0, 0), "neck": (4, 0, 0), "head": (6, 0, 0),
                          "upperarm.R": (-38, 22, 34), "forearm.R": (-98, 0, 0), "hand.R": (-26, 0, -8),
                          "upperarm.L": (-38, -22, -34), "forearm.L": (-98, 0, 0), "hand.L": (-26, 0, 8)})
    open_b = merge(HANG, {"spine": (-4, 0, 0), "chest": (-9, 0, 0), "neck": (-5, 0, 0), "head": (-12, 0, 0),
                          "upperarm.R": (-26, 45, 66), "forearm.R": (-48, 0, 0), "hand.R": (-20, 0, 0),
                          "upperarm.L": (-26, -45, -66), "forearm.L": (-48, 0, 0), "hand.L": (-20, 0, 0)})
    hold_b = merge(open_b, {"spine": (-5, 0, 0), "chest": (-11, 0, 0), "neck": (-7, 0, 0), "head": (-16, 0, 0),
                            "upperarm.R": (-30, 50, 70), "forearm.R": (-46, 0, 0), "hand.R": (-12, 0, 0),
                            "upperarm.L": (-30, -50, -70), "forearm.L": (-46, 0, 0), "hand.L": (-12, 0, 0)})
    soft_b = merge(HANG, {"spine": (1, 0, 0), "chest": (0, 0, 0), "neck": (-2, 0, 0), "head": (-3, 0, 0),
                          "upperarm.R": (-24, 10, 38), "forearm.R": (-54, 0, 0), "hand.R": (-8, 0, 0),
                          "upperarm.L": (-24, -10, -38), "forearm.L": (-54, 0, 0), "hand.L": (-8, 0, 0)})
    sink_f = rest
    toe_f = {"L": _foot(arm, "L", toes=9), "R": _foot(arm, "R", toes=9)}
    k = [
        (1, HANG_STAFF, ((0, 0, -0.004), 0, 0, 0), rest),
        (4, blend(HANG_STAFF, reach_b, 1.0), _hips(arm, knee=10, lead="L", feet=sink_f, pitch=1), sink_f),
        (8, bow_b, _hips(arm, knee=22, lead="L", feet=sink_f, pitch=3), sink_f),
        (11, still_b, _hips(arm, knee=32, lead="L", feet=sink_f, pitch=5), sink_f),
        (13, lift_b, _hips(arm, rise=0.004, pitch=0), blend_feet(arm, rest, toe_f, 0.4)),
        (15, open_b, _hips(arm, rise=0.026, pitch=-3), toe_f),
        (19, hold_b, _hips(arm, rise=0.030, pitch=-4), toe_f),
        (22, soft_b, _hips(arm, rise=0.008), blend_feet(arm, toe_f, rest, 0.7)),
        (25, HANG_STAFF, ((0, 0, -0.004), 0, 0, 0), rest),
    ]
    end = _cast_clip(arm, "cast_pray", k)
    _aim_fist(arm, {f: UP for f in (1, 4, 8, 11, 13, 15, 19, 22, 25)})
    return "cast_pray", (1, end), (CAST_RELEASE - 1) / 24.0


# --- idle_hero: the player's stance ---------------------------------------------
#
# `idle` is two seconds of a figure at rest, written for a crowd. The player
# is looked at from three metres behind for hours, and at two seconds with a
# centimetre of hand travel it read as a pose with the power off. This one is
# seven seconds: the weight goes from the right leg to the left and back (the
# hips travel over the standing foot while both feet stay planted, a little
# apart and turned out, the leading one forward so its knee stays soft), the
# chest breathes twice, the head looks to one side and then the other, and the
# arms hang loose with the hands a little forward. First key = last key, and
# every key is sampled from periodic curves so nothing can fail to close.

IDLE_HERO_FRAMES = 168


def anim_idle_hero(arm):
    """The loop is a function of t in [0, 1): `w` is where the weight is (0
    on the right foot, 1 on the left) and moves twice, `breath` is two
    breaths, `look` is a glance to one side then a longer one to the other."""
    rest = _rest_feet(arm)
    # Left foot forward and out, right back: neither is moved after this, so
    # neither can skate. Each foot's yaw is its toe turned a little outward.
    feet = {"L": _foot(arm, "L", dx=0.045, dy=-0.07, yaw=14), "R": _foot(arm, "R", dx=-0.045, dy=0.015, yaw=-12)}

    def ease(x):
        x = min(max(x, 0.0), 1.0)
        return x * x * (3.0 - 2.0 * x)

    def bump(t, c, wdt):
        # A periodic bell: the distance to c is taken round the loop.
        d = (t - c + 0.5) % 1.0 - 0.5
        return math.exp(-(d / wdt) ** 2)

    k = []
    step = 6
    frames = list(range(1, IDLE_HERO_FRAMES + 1, step)) + [IDLE_HERO_FRAMES + 1]
    for f in frames:
        t = ((f - 1) % IDLE_HERO_FRAMES) / IDLE_HERO_FRAMES
        # Onto the left foot over 0.36-0.52 of the loop, back over 0.80-0.95.
        w = ease((t - 0.36) / 0.16) - ease((t - 0.80) / 0.15)
        s = 2.0 * w - 1.0
        breath = 0.5 - 0.5 * math.cos(2.0 * math.pi * (2.0 * t - 0.1))
        look = 0.85 * bump(t, 0.27, 0.07) - 0.55 * bump(t, 0.68, 0.08)
        sway = math.sin(2.0 * math.pi * t)
        # The arms swing a little against the hips and ride the breath.
        arms = {
            "upperarm.L": (-9 + 2.5 * s - 1.0 * breath, 0, -6 - 1.5 * breath),
            "upperarm.R": (-9 - 2.5 * s - 1.0 * breath, 0, 6 + 1.5 * breath),
            "forearm.L": (-26 - 3.0 * breath + 2.0 * s, 0, 0),
            "forearm.R": (-26 - 3.0 * breath - 2.0 * s, 0, 0),
            "hand.L": (-6, 0, 3), "hand.R": (-6, 0, -3),
            "shoulder.L": (0, 0, -1.0 * breath), "shoulder.R": (0, 0, 1.0 * breath),
        }
        trunk = {
            "spine": (-0.8 - 1.2 * breath, 0.8 * look * 4.0, 1.4 * s),
            "chest": (-1.4 - 2.4 * breath, 1.6 * look * 4.0, -1.4 * s),
            "neck": (-1.0 + 0.6 * breath, 14.0 * look, 0.8 * s),
            "head": (-1.5 + 1.2 * bump(t, 0.27, 0.07) - 0.4 * breath, 20.0 * look, -0.6 * s),
        }
        # The hips ride over the standing foot and dip as the weight crosses.
        dip = -0.010 * (1.0 - abs(s) ** 1.5)
        hips = _hips(arm, x=0.040 * s, y=0.004 * sway, rise=dip, yaw=2.0 * s + 3.0 * look, roll=2.6 * s,
                     pitch=-0.5 * breath)
        k.append((f, merge(HANG, arms, trunk), hips, feet))
    end = _cast_clip(arm, "idle_hero", k)
    return "idle_hero", (1, end)


CAST_ANIMS = [anim_cast_thrust, anim_cast_overhead, anim_cast_sweep, anim_cast_pray]


def torso_clearance(arm, P, frames, margin=0.02):
    """The least gap, in metres, between a hand or the lower forearm and the
    trunk over a clip, as `head_clearance` does for the head: points down each
    limb against the cross-section of the torso at their height (girths from
    the body's own table), in the rest frame of the nearest of hips, spine and
    chest. Negative is a hand in the belly."""
    scene = bpy.context.scene
    hz = P["hip"][2]
    levels = [(hz - 0.05, P["hips"]), (hz + 0.18, P["waist"]), (P["shoulder"][2] - 0.15, P["chest"]),
              (P["neck_base"], P["chest"])]
    worst = (9.0, None, None)
    for f in range(frames[0], frames[1] + 1):
        scene.frame_set(f)
        for t in "LR":
            for limb, ks in (("forearm", (3, 4, 5)), ("hand", (0, 2, 4, 5))):
                pb = arm.pose.bones[limb + "." + t]
                for k in ks:
                    pt = pb.head + (pb.tail - pb.head) * (k / 5.0)
                    best = None
                    for bn in ("hips", "spine", "chest"):
                        bone = arm.pose.bones[bn]
                        q = arm.data.bones[bn].matrix_local @ (bone.matrix.inverted() @ pt)
                        seg = (arm.data.bones[bn].head_local.z, arm.data.bones[bn].tail_local.z)
                        out = max(seg[0] - q.z, q.z - seg[1], 0.0)
                        if best is None or out < best[0]:
                            best = (out, q)
                    q = best[1]
                    if q.z < levels[0][0] or q.z > levels[-1][0]:
                        continue
                    for (z0, g0), (z1, g1) in zip(levels, levels[1:]):
                        if z0 <= q.z <= z1:
                            u = (q.z - z0) / max(z1 - z0, 1e-6)
                            w = g0[0] + (g1[0] - g0[0]) * u
                            d = max(g0[1], g0[2]) + (max(g1[1], g1[2]) - max(g0[1], g0[2])) * u
                            r = math.hypot(q.x / w, q.y / d)
                            gap = (r - 1.0) * min(w, d) - margin
                            if gap < worst[0]:
                                worst = (gap, f, limb + "." + t)
                            break
    return worst


def measure_casts(arm, P, info):
    """The casts' hand clearance of the head and the trunk, in the clips'
    facts; a hand in either is a fault at build time, as for the swings."""
    for fn in CAST_ANIMS:
        name = fn.__name__[len("anim_"):]
        arm.animation_data.action = bpy.data.actions[name]
        span = (0, info[name]["frames"])
        gap, f, limb = head_clearance(arm, P, span)
        info[name]["head_gap"] = round(gap, 4)
        if gap < 0:
            raise RuntimeError("%s: %s goes %.0f mm into the head at frame %d of %s"
                               % (P["name"], limb, -gap * 1000, f, name))
        gap, f, limb = torso_clearance(arm, P, span)
        info[name]["body_gap"] = round(gap, 4)
        if gap < 0:
            raise RuntimeError("%s: %s goes %.0f mm into the trunk at frame %d of %s"
                               % (P["name"], limb, -gap * 1000, f, name))


CLIPS = ("idle", "idle2", "walk", "run", "fight", "attack", "attack2", "hit", "block", "death",
         "cast", "sit", "lean", "talk", "jump", "land", "kick", "backstab", "disarm",
         "jog", "sprint", "strafe_l", "strafe_r", "back", "turn_l", "turn_r",
         "cast_thrust", "cast_overhead", "cast_sweep", "cast_pray", "idle_hero")


def make_all(arm, measure=True, P=None, extra=()):
    """Author every clip on the IK rig, bake them, strip the controls, and
    write the baked clips back as plain actions. Returns what the viewer
    needs to know about them: durations, strides, contact frames, and the
    measured foot slip of the locomotion."""
    add_controls(arm)
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode="POSE")
    baked = {}
    info = {}
    fns = [anim_idle, anim_idle2, anim_walk, anim_run, anim_fight, anim_attack, anim_attack2,
           anim_hit, anim_block, anim_death, anim_cast, anim_sit, anim_lean, anim_talk,
           anim_jump, anim_land, anim_kick, anim_backstab, anim_disarm, anim_jog, anim_sprint,
           anim_strafe_l, anim_strafe_r, anim_back, anim_turn_l, anim_turn_r] + list(extra)
    fns += CAST_ANIMS + [anim_idle_hero]
    for fn in fns:
        r = fn(arm)
        name, frames = r[0], r[1]
        extra = r[2] if len(r) > 2 else None
        act = arm.animation_data.action
        baked[name] = (bake(arm, act, frames), frames)
        entry = {"frames": frames[1] - frames[0], "duration": (frames[1] - frames[0]) / FPS}
        if isinstance(extra, dict):
            entry.update(extra)
            if measure:
                entry["slip"], entry["sink"] = foot_slip(arm, frames, extra["stride"], extra["stance"],
                                                         extra.get("direction"))
        elif extra is not None:
            entry["hit"] = extra
        info[name] = entry
    for name in CARRY:
        r = anim_carry(arm, name)
        baked[name] = (bake(arm, arm.animation_data.action, r[1]), r[1])
    for act in [a for a in bpy.data.actions if a.name.startswith("_")]:
        bpy.data.actions.remove(act)
    bpy.ops.object.mode_set(mode="OBJECT")
    strip_controls(arm)
    for name, (samples, frames) in baked.items():
        commit(arm, name, samples)
    if measure and P is not None:
        for name in ("attack", "attack2", "cast", "block", "fight", "hit", "idle2", "lean", "talk", "jump", "land",
                     "kick", "backstab", "disarm", "jog", "sprint", "strafe_l", "strafe_r", "back", "turn_l",
                     "turn_r", "idle_hero"):
            arm.animation_data.action = bpy.data.actions[name]
            gap, f, limb = head_clearance(arm, P, (0, info[name]["frames"]))
            info[name]["head_gap"] = round(gap, 4)
            if gap < 0:
                raise RuntimeError("%s: %s goes %.0f mm into the head at frame %d of %s"
                                   % (P["name"], limb, -gap * 1000, f, name))
        for name in ("walk", "run") + NEW_LOCOMOTION:
            arm.animation_data.action = bpy.data.actions[name]
            fr = (0, info[name]["frames"])
            info[name]["slip_baked"], _ = foot_slip(arm, fr, info[name]["stride"], info[name]["stance"],
                                                    info[name].get("direction"))
    if measure and P is not None:
        measure_casts(arm, P, info)
    arm.animation_data.action = bpy.data.actions["idle"]
    return info
