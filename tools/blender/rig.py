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
FACE_BONES = ("eye.L", "eye.R", "jaw", "nose")


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
    return out


def deform_face(arm):
    select_only([arm], arm)
    for n in FACE_BONES:
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
        samples.append(row)
    return samples


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
                 lean=3.0, sway=0.015, yaw=5.0, roll=3.0, bob=0.0, aft=0.01, reach=0.998, kick=0.85):
        self.arm = arm
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
            y = rest_heel.y + self.stride * (ph - be / 2) + self.aft
            h = V((A.x, y, 0.0))
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
        m0 = V((0.0, v * (1.0 - be) * 0.6, 0.0))
        m1 = V((0.0, v * (1.0 - be) * 0.4, 0.0))
        pos = _hermite(a0, a1, m0, m1, s)
        pos.z += self.lift * math.sin(math.pi * min(1.0, s ** self.kick))
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

def foot_slip(arm, frames, stride, stance):
    """Worst drift of a planted foot, in metres, over a locomotion clip, read
    off the deforming bones -- so it can be run on the baked clip with the IK
    gone, which is the one that ships.

    Planted is the stance phase the gait was built with, less a frame at each
    end. Within it the contact point is whichever of the heel and the ball
    is lower; that point plus the ground the figure has covered since the
    cycle began should not move. Also returns the lowest either point goes,
    which is how far a sole sinks into the paving."""
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
            seen.append((p.y - speed * (f - frames[0]), ("heel" if p is heel else "ball", plant), f))
        # Drift within each run of the same contact point.
        runs = {}
        for (y, k, f) in seen:
            runs.setdefault(k, []).append(y)
        for ys in runs.values():
            worst = max(worst, max(ys) - min(ys))
    return worst, sink


# --- poses --------------------------------------------------------------------

# Where the feet stand, per stance: (ankle offset from rest (x, y), yaw, pitch).
STANCES = {
    "rest": {"L": ((0.004, 0.0), 6.0, 0.0), "R": ((-0.004, 0.0), -6.0, 0.0)},
    # Left foot leading, right foot back and turned out: a swordsman's stance.
    "guard": {"L": ((0.030, -0.200), 16.0, 0.0), "R": ((-0.040, 0.210), -38.0, 0.0)},
    "lunge": {"L": ((0.030, -0.330), 12.0, 0.0), "R": ((-0.040, 0.210), -38.0, 0.0)},
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
            b.update({"upperarm.R": (-128, 0, 38), "forearm.R": (-128, 0, 0), "hand.R": (-20, 0, 0)})
        sway = 0.008 if look > 0 else (-0.008 if look < 0 else 0.0)
        k.append((f, b, ((sway, 0.0, -0.005), 0.0, look * 0.08, -sway * 100), "rest"))
    # The rub itself: two strokes of the hand while it is up.
    act = _clip(arm, "idle2", k)
    p = arm.pose.bones
    for (f, dx) in ((65, -12), (68, 6), (70, -10)):
        fk(p["forearm.R"], f, x=-128 + dx)
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
        (7, merge(GUARD, {"spine": (0, -4, 0), "chest": (-4, -10, 0), "head": (-6, 14, 0),
                          "upperarm.R": (-150, 0, 42), "forearm.R": (-105, 0, 0), "hand.R": (30, 0, 0),
                          "upperarm.L": (-40, 40, 14)}),
         ((0.0, 0.02, -0.05), 2.0, -36.0, 0.0), "guard"),
        (9, merge(GUARD, {"spine": (6, 6, 0), "chest": (2, 2, 0), "head": (-6, 4, 0),
                          "upperarm.R": (-140, 0, 30), "forearm.R": (-70, 0, 0), "hand.R": (40, 0, 0),
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
    return "death", (1, _clip(arm, "death", k))


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
    return "cast", (1, _clip(arm, "cast", k)), (15 - 1) / 24.0


def anim_carry(arm, name):
    new_action(arm, name)
    pose(arm, 1, CARRY[name])
    pose(arm, 2, CARRY[name])
    return name, (1, 2)


CLIPS = ("idle", "idle2", "walk", "run", "fight", "attack", "attack2", "hit", "block", "death",
         "cast")


def make_all(arm, measure=True):
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
           anim_hit, anim_block, anim_death, anim_cast]
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
                entry["slip"], entry["sink"] = foot_slip(arm, frames, extra["stride"], extra["stance"])
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
    if measure:
        for name in ("walk", "run"):
            arm.animation_data.action = bpy.data.actions[name]
            fr = (0, info[name]["frames"])
            info[name]["slip_baked"], _ = foot_slip(arm, fr, info[name]["stride"], info[name]["stance"])
    arm.animation_data.action = bpy.data.actions["idle"]
    return info
