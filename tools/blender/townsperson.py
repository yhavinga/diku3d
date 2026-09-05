"""townsperson -- a 1.75 m human with an armature and three baked actions.

The mesh is segmented: every limb is its own closed solid, bound rigidly to one
bone at weight 1.0. That is deliberate rather than a shortcut. A single-skin
humanoid at this triangle count has to be weighted across joints, and a joint
weighted across six triangles pinches into an hourglass the first time you bend
it. Separate solids cannot pinch, they are trivially clean topology, and the
seams are hidden by making each solid overlap the next -- a deltoid that laps
over the top of the sleeve, a sleeve cuff that laps over the forearm, a tunic
hem that laps over the hose.

The first version of this was 644 triangles of primitives and read, correctly,
as a shop mannequin: a sphere on a box, capsule arms hanging outside the
shoulder line with daylight between, and legs that stopped at the ankle. The
rebuild is laid out on a proper canon -- seven and a half heads at 1.75 m, so
one head is 233 mm: chin 1.517, shoulder 1.42, waist 1.09, crotch 0.875, knee
0.50, ankle 0.09 -- and every solid is a lib.loft() with a silhouette instead of
a primitive.

Clothing is its own geometry, not a colour: the tunic is a separate solid over
the body with a flared hem and a lip under it, the sleeve ends in a cuff the
skin forearm comes out of, and the hose are their own solids inside the hem.
Only skin and cloth are tinted per person by the viewer, so the belt, the boots
and the hair are deliberately left untinted -- that is what stops a crowd of
these looking like one man printed forty times. They are not all one tag
either: the belt and purse are `oak`, the boots `leather` and the hair `hair`,
which the viewer bakes at 0x4a3524 and 0x3a2a1c against oak's 0x5a4330. Boots
in oak came back from a review as "orange wedges", and they were: a warm mid
brown under a sun that is now four times what it was.

Bone rolls put every bone's local X on global +X, so rotating a bone about its
local X swings it forward and back and the walk cycle reads as a table rather
than a puzzle. Getting that took two goes. `calculate_roll(GLOBAL_POS_X)` does
*not* do it: like every roll operator in Blender it aims the bone's **Z** axis
at the vector you name, so it put local Z on +X and left local X on the
figure's own facing -- which is the sideways-splay axis. Every limb in the walk
therefore scissored across the figure instead of swinging along it, measured at
0.247 m across against 0.012 m along, and the viewer carried a load-time
`uprightSwing()` that conjugated every keyed quaternion a quarter turn to
compensate. That compensation could only ever be half a fix, because a glTF
track holds the bone's *whole* local rotation, rest included: conjugating it
also swung both shoulders a quarter turn about the spine -- one arm in front of
the chest, one behind it, 0.16 m out of its socket -- and turned each foot a
quarter turn off its leg. Rolled from here with `align_roll`, which is the same
Z-aiming operator handed `+X x direction`, and the keyed axis is the one the
tables below say it is.

The three axes then mean, for a bone hanging down (every limb): x swings it
fore and aft, positive backwards; z swings it out from the body; y twists it.
For a bone standing up (hips to head): x pitches it, positive forward; y turns
it about the spine; z rolls it sideways.
"""

import math
import importlib

import bpy
import mathutils

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


def part(sections, bone, mat="cloth", sides=8, axis="z", name=None, mirror=0.0):
    """One lofted solid and the single bone it is welded to. `mirror` shifts
    every ring sideways, which is how the left and right limbs are the same
    table of numbers with one sign flipped."""
    if mirror:
        sections = [(t, ra, rb, ca + mirror, cb) if axis != "x" else (t + mirror, ra, rb, ca, cb)
                    for (t, ra, rb, ca, cb) in sections]
    obj = lib.loft(sections, sides=sides, axis=axis, name=name or bone, mat=mat)
    return obj, bone


def head_parts():
    """Skull, hair, nose, ears, brows, eyes and a mouth. The skull is an egg
    with a jaw: the silhouette a human head makes from behind is the one thing a
    sphere gets wrong, and it is the only view you ever get of a mobile walking
    away.

    A face at three metres is not a sculpt, it is four dark marks and one
    shadow. Skin on skin reads as nothing at that distance -- the nose and ears
    below have been there all along and a review still called the head a
    featureless block -- so the features that carry are the ones in a different
    material: brows and eyes in `hair`, a mouth in `leather`, and a brow that
    stands 7 mm proud so the sun lays a bar of shade across the eyes under it.
    They are set on the flats of the ten-sided skull rather than on the ellipse
    it approximates, which is why the numbers are not symmetrical about the
    nose: the front facet only runs to x = 0.024."""
    skull = [(1.500, 0.058, 0.062, 0.0, 0.010),
             (1.540, 0.070, 0.082, 0.0, -0.004),
             (1.585, 0.078, 0.094, 0.0, -0.010),
             (1.640, 0.081, 0.096, 0.0, -0.006),
             (1.692, 0.078, 0.090, 0.0, 0.002),
             (1.732, 0.061, 0.068, 0.0, 0.008),
             (1.751, 0.026, 0.028, 0.0, 0.010)]
    # Hair down the sides and the nape, and a hairline across the front at 1.70.
    # The lower rings are pushed back rather than dropped: at the sides and the
    # back they stand 5 mm proud of the skull and show, at the front they sit
    # 20 mm inside it and do not. The ring this replaces was at 1.648 with no
    # offset, which is a hairline *below* the brow -- there was no forehead at
    # all, and the eyes and brows below came out as dark marks on dark hair.
    hair = [(1.598, 0.083, 0.080, 0.0, 0.020),
            (1.652, 0.086, 0.092, 0.0, 0.014),
            (1.700, 0.083, 0.095, 0.0, 0.003),
            (1.740, 0.066, 0.073, 0.0, 0.009),
            (1.760, 0.028, 0.030, 0.0, 0.011)]
    # A nose has to taper or it is a stripe down the face: four rings, widening
    # and pushing further out as they fall, and 20 mm proud of the cheek at the
    # tip. A square prism the same size read as a nameplate.
    nose = [(1.664, 0.010, 0.009, 0.0, -0.090),
            (1.632, 0.015, 0.015, 0.0, -0.100),
            (1.602, 0.019, 0.021, 0.0, -0.104),
            (1.590, 0.013, 0.011, 0.0, -0.096)]
    parts = [part(skull, "head", "skin", sides=10, name="skull"),
             part(hair, "head", "hair", sides=10, name="hair"),
             part(nose, "head", "skin", sides=6, name="nose")]
    # Ears sit behind the midline of the skull, not on it, and project 10 mm.
    for sx in (-1, 1):
        parts.append((kit.timber((0.013, 0.030, 0.044), (sx * 0.075, 0.012, 1.618),
                                 (0, 0, 0), "skin", 0.008, "ear"), "head"))
    for sx in (-1, 1):
        # Both are turned to lie along the cheek rather than across it: the
        # skull falls away 12 mm over the width of an eye, and a mark left flat
        # buries its outer end and floats its inner one.
        parts.append((kit.timber((0.038, 0.016, 0.011), (sx * 0.032, -0.0795, 1.685),
                                 (0, sx * math.radians(8), sx * math.radians(22)),
                                 "hair", 0.003, "brow"), "head"))
        parts.append((kit.timber((0.024, 0.012, 0.012), (sx * 0.028, -0.0855, 1.662),
                                 (0, 0, sx * math.radians(24)),
                                 "hair", 0.003, "eye"), "head"))
    parts.append((kit.timber((0.034, 0.010, 0.008), (0.0, -0.089, 1.566), (0, 0, 0),
                             "leather", 0.002, "mouth"), "head"))
    return parts


def arm_parts(sx, tag):
    x = sx * 0.205
    # The deltoid laps over the top of the sleeve and back onto the chest, which
    # is the whole fix for "capsule arms floating outside the shoulder".
    deltoid = [(1.505, 0.050, 0.062, sx * 0.120, 0.0),
               (1.462, 0.068, 0.080, sx * 0.152, 0.0),
               (1.402, 0.066, 0.078, sx * 0.180, 0.0),
               (1.338, 0.056, 0.068, sx * 0.196, 0.0)]
    sleeve = [(1.470, 0.060, 0.070, x, 0.0),
              (1.390, 0.056, 0.064, x, 0.0),
              (1.285, 0.051, 0.058, x, 0.0),
              (1.200, 0.055, 0.061, x, 0.0),
              (1.182, 0.048, 0.054, x, 0.0)]
    forearm = [(1.196, 0.046, 0.050, x, 0.0),
               (1.110, 0.042, 0.045, x, 0.0),
               (1.010, 0.034, 0.037, x, 0.0),
               (0.944, 0.029, 0.032, x, 0.0)]
    hand = [(0.950, 0.030, 0.036, x, 0.0),
            (0.905, 0.035, 0.046, x, -0.004),
            (0.862, 0.033, 0.045, x, -0.004),
            (0.818, 0.026, 0.035, x, -0.002)]
    parts = [part(deltoid, "shoulder." + tag, "cloth", sides=8, name="deltoid"),
             part(sleeve, "upperarm." + tag, "cloth", sides=8, name="sleeve"),
             part(forearm, "forearm." + tag, "skin", sides=8, name="forearm"),
             part(hand, "hand." + tag, "skin", sides=6, name="palm")]
    # The thumb. 28 triangles, and without it a hand is a mitten.
    parts.append((kit.timber((0.024, 0.030, 0.078),
                             (x - sx * 0.024, -0.030, 0.906),
                             (math.radians(28), sx * math.radians(22), 0),
                             "skin", 0.01, "thumb"), "hand." + tag))
    return parts


def leg_parts(sx, tag):
    x = sx * 0.092
    thigh = [(0.985, 0.084, 0.089, x, 0.0),
             (0.870, 0.078, 0.084, x, 0.0),
             (0.700, 0.067, 0.072, x, 0.0),
             (0.560, 0.057, 0.061, x, 0.0),
             (0.512, 0.055, 0.059, x, 0.0)]
    shin = [(0.535, 0.057, 0.061, x, 0.0),
            (0.455, 0.061, 0.067, x, -0.006),
            (0.310, 0.047, 0.051, x, -0.002),
            (0.150, 0.035, 0.039, x, 0.0),
            (0.088, 0.033, 0.037, x, 0.002)]
    # The shoe is lofted along Y, because a foot is a long shape and rings
    # stacked in Z would need twice as many to describe the same silhouette.
    # Eight sides rather than six, and a blunt toe made of two short rings
    # instead of one long taper: at six sides tapering to a 19 mm point this
    # read, correctly, as a wedge.
    shoe = [(0.078, 0.036, 0.038, x, 0.044),
            (0.020, 0.045, 0.049, x, 0.048),
            (-0.060, 0.047, 0.047, x, 0.045),
            (-0.140, 0.044, 0.038, x, 0.037),
            (-0.196, 0.036, 0.030, x, 0.030),
            (-0.216, 0.022, 0.021, x, 0.026)]
    # The ankle was the one joint in the figure with no lap over it: the hose
    # stopped at z = 0.088 and the shoe began below it, so every degree the foot
    # turned opened daylight between them, and a review reported the left foot
    # as detached and hanging. The cuff belongs to the shin, like the sleeve
    # cuff over the forearm, so the shoe turns *inside* it and the joint is
    # covered whatever the ankle is doing.
    cuff = [(0.150, 0.038, 0.042, x, 0.000),
            (0.104, 0.046, 0.050, x, 0.004),
            (0.052, 0.051, 0.057, x, 0.008)]
    return [part(thigh, "thigh." + tag, "cloth", sides=8, name="hose"),
            part(shin, "shin." + tag, "cloth", sides=8, name="hose"),
            part(cuff, "shin." + tag, "leather", sides=8, name="cuff"),
            part(shoe, "foot." + tag, "leather", sides=8, axis="y", name="shoe"),
            (kit.timber((0.092, 0.30, 0.022), (x, -0.068, 0.012), (0, 0, 0),
                        "leather", 0.008, "sole"), "foot." + tag)]


def body():
    """(object, bone) for every solid."""
    chest = [(1.270, 0.150, 0.096, 0.0, 0.0),
             (1.345, 0.168, 0.103, 0.0, 0.0),
             (1.420, 0.180, 0.104, 0.0, -0.002),
             (1.472, 0.152, 0.094, 0.0, -0.004),
             (1.505, 0.100, 0.072, 0.0, -0.004)]
    spine = [(1.075, 0.143, 0.097, 0.0, 0.0),
             (1.160, 0.138, 0.095, 0.0, 0.0),
             (1.240, 0.146, 0.097, 0.0, 0.0),
             (1.292, 0.153, 0.099, 0.0, 0.0)]
    hips = [(0.918, 0.142, 0.097, 0.0, 0.0),
            (1.000, 0.151, 0.100, 0.0, 0.0),
            (1.082, 0.147, 0.098, 0.0, 0.0)]
    # Tunic: its own solid over the body, flared to a hem with a lip under it,
    # so there is a real edge for the light to break on and the hose below it
    # are visibly a different garment.
    # The flare goes into the depth, not the width: the hands hang at x = 0.205
    # and an evenly flared skirt buries them in cloth to the knuckle.
    tunic = [(1.030, 0.150, 0.108, 0.0, 0.0),
             (0.905, 0.161, 0.124, 0.0, 0.0),
             (0.790, 0.170, 0.140, 0.0, 0.0),
             (0.735, 0.175, 0.147, 0.0, 0.0),
             (0.716, 0.166, 0.138, 0.0, 0.0)]
    belt = [(1.086, 0.157, 0.104, 0.0, 0.0),
            (1.126, 0.160, 0.107, 0.0, 0.0),
            (1.146, 0.155, 0.103, 0.0, 0.0)]
    collar = [(1.478, 0.088, 0.070, 0.0, -0.004),
              (1.512, 0.079, 0.064, 0.0, -0.004),
              (1.530, 0.068, 0.056, 0.0, -0.003)]
    neck = [(1.430, 0.052, 0.055, 0.0, 0.0),
            (1.490, 0.049, 0.052, 0.0, -0.002),
            (1.528, 0.047, 0.050, 0.0, -0.004)]
    parts = [part(chest, "chest", "cloth", sides=12, name="tunic_chest"),
             part(spine, "spine", "cloth", sides=12, name="tunic_waist"),
             part(hips, "hips", "cloth", sides=12, name="tunic_hip"),
             part(tunic, "hips", "cloth", sides=12, name="tunic_skirt"),
             part(belt, "spine", "oak", sides=12, name="belt"),
             part(collar, "chest", "cloth", sides=10, name="collar"),
             part(neck, "neck", "skin", sides=8, name="neck")]
    parts.append((kit.timber((0.062, 0.036, 0.052), (0, -0.104, 1.116), (0, 0, 0),
                             "iron", 0.012, "buckle"), "spine"))
    # A purse on the hip. It is the only asymmetric thing on the figure and it
    # is what tells you at a glance which way round a distant mobile is facing.
    parts.append((lib.loft([(1.070, 0.036, 0.026, 0.132, -0.044),
                            (1.010, 0.052, 0.036, 0.136, -0.048),
                            (0.958, 0.048, 0.033, 0.138, -0.048)],
                           sides=8, name="purse", mat="oak"), "spine"))
    parts += head_parts()
    for (sx, tag) in ((1, "L"), (-1, "R")):
        parts += arm_parts(sx, tag)
        parts += leg_parts(sx, tag)
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
    # Roll every bone so its local X is world +X: then one axis means "forward".
    # align_roll aims the bone's *Z* axis, so the target is +X x bone, which
    # puts X = Y x Z back on +X. calculate_roll(GLOBAL_POS_X) aims the same Z
    # axis and so does the opposite of what its name suggests -- see the module
    # docstring. The two shoulders point along +-X themselves, the cross product
    # degenerates, and neither is ever keyed; they get an upright frame.
    for bone in eb:
        direction = (bone.tail - bone.head).normalized()
        target = mathutils.Vector((1.0, 0.0, 0.0)).cross(direction)
        bone.align_roll(target if target.length > 1e-4 else mathutils.Vector((0.0, 0.0, 1.0)))
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
    # The knee only ever bends one way -- positive, the heel towards the seat --
    # and it bends most at mid-swing. The two frames it is not a free choice are
    # the two the foot is flat on the ground: at mid-stance the leg has to be
    # near straight, because a straight vertical leg is the *longest* the figure
    # gets and anything else lifts the sole off the paving.
    for (f, l, r) in ((1, 20, 4), (7, 34, 4), (13, 4, 20), (19, 4, 34), (25, 20, 4)):
        key(p["shin.L"], f, x=l)
        key(p["shin.R"], f, x=r)
    # The ankle is not free either. What has to look right is the sole against
    # the ground, and that is thigh + shin + foot, not the foot on its own: at
    # mid-stance the sum has to be 0 or the sole is not flat, at push-off it has
    # to put the toe on the paving and not through it, and at heel strike the
    # heel. A -1 here is a sole 14 degrees toe-up, because the thigh is already
    # 17 degrees forward -- read the sums, not the numbers.
    # The extra pair two frames before each contact is the ankle rolling up over
    # the planted foot at the end of stance, and then snapping down into the
    # push. Without it the sole is left tilted toe-down while the leg is still
    # long, and the toe ploughs 25 mm of paving.
    for (f, l, r) in ((1, -5, -1), (7, -16, -4), (11, -6, -13), (13, -1, -5),
                      (19, -4, -16), (23, -13, -6), (25, -5, -1)):
        key(p["foot.L"], f, x=l)
        key(p["foot.R"], f, x=r)
    for (f, a) in ((1, -14), (7, -18), (13, -14), (19, -18), (25, -14)):
        key(p["forearm.L"], f, x=a)
        key(p["forearm.R"], f, x=a)
    # The pelvis is highest at the passing pose, where one leg is straight under
    # it, and lowest with the legs apart -- so this is a *drop* at contact, not
    # a rise at passing. Keyed the other way round it holds the hips 22 mm above
    # what the legs can reach and the supporting foot hangs in the air all the
    # way through stance. `loc` is along the bone, which for the hips is up.
    # The roll drops the side whose leg is in the air.
    for (f, dy, roll) in ((1, -0.015, 0.0), (7, 0.0, -3.0), (13, -0.015, 0.0),
                          (19, 0.0, 3.0), (25, -0.015, 0.0)):
        key(p["hips"], f, z=roll, loc=(0, dy, 0))
    # Shoulders counter the hips: the arm that is forward is the shoulder that
    # is forward, and the head holds its line against both.
    for (f, a) in ((1, 4.0), (7, 0.0), (13, -4.0), (19, 0.0), (25, 4.0)):
        key(p["chest"], f, y=-a)
        key(p["head"], f, y=a * 0.6)
    return act


def anim_idle(arm):
    """Sixty frames of standing about: breathing, a shift of weight and a look
    to one side. Nothing symmetric, or it reads as a machine at rest."""
    act = action(arm, "idle", 61)
    p = arm.pose.bones
    # Weight shifted from foot to foot, and no vertical: the legs are straight
    # here, so a hip that rises 13 mm takes both soles 13 mm off the ground with
    # it. The breath is in the chest, which is where it shows anyway.
    for (f, roll) in ((1, 0.0), (18, 1.2), (34, 1.6), (48, 0.7), (61, 0.0)):
        key(p["hips"], f, z=roll)
    for (f, a) in ((1, 0.0), (20, -1.6), (40, 0.6), (61, 0.0)):
        key(p["chest"], f, x=a)
        key(p["spine"], f, x=a * 0.5)
    for (f, nod, turn) in ((1, 0, 0), (16, -2, 9), (30, 1, 5), (44, -1, -7), (61, 0, 0)):
        key(p["head"], f, x=nod, y=turn)
    # The arms are held a few degrees off the ribs -- z on a hanging bone is the
    # axis that takes them out from the body, x the one that takes them forward.
    for (f, a, b) in ((1, 3, 3), (24, 5, 2), (46, 2, 4), (61, 3, 3)):
        key(p["upperarm.L"], f, x=a, z=-4)
        key(p["upperarm.R"], f, x=b, z=4)
    for (f, a) in ((1, -8), (28, -12), (52, -6), (61, -8)):
        key(p["forearm.L"], f, x=a)
        key(p["forearm.R"], f, x=a * 0.8)
    return act


def anim_fight(arm):
    """Forty frames: guard, a right-handed overhand cut on 13-19, recover.

    Held in a side-on guard rather than square, because a figure that swings
    from a shop-window stance reads as a puppet however good the swing is. The
    weight goes forward on the cut and the hips lead the shoulders by three
    frames, which is the only thing in here that makes it look like effort."""
    act = action(arm, "fight", 41)
    p = arm.pose.bones
    # How far the hips drop is not a taste setting: it is however much the front
    # knee has taken out of that leg, or the front foot leaves the ground. The
    # lean counts too -- a pelvis pitched 9 degrees into the cut swings both
    # thighs with it, and leaving that out of the sum buries the front foot.
    for (f, turn, lean, dy) in ((1, 26, 0, -0.017), (10, 30, -2, -0.031), (16, 6, 9, -0.040),
                                (22, 10, 6, -0.032), (32, 24, 1, -0.022), (41, 26, 0, -0.017)):
        key(p["hips"], f, x=lean, y=turn, loc=(0, dy, 0))
    for (f, turn, lean) in ((1, 14, -4), (10, 20, -8), (16, -14, 12), (22, -8, 8),
                            (32, 12, -2), (41, 14, -4)):
        key(p["chest"], f, x=lean, y=turn)
        key(p["spine"], f, x=lean * 0.4, y=turn * 0.4)
        key(p["head"], f, y=-turn * 0.8)
    # Sword arm: cocked back over the shoulder, then through and down.
    for (f, up, out, el) in ((1, -108, -26, -96), (10, -132, -34, -118), (16, 46, -8, -18),
                             (22, 14, -12, -34), (32, -96, -22, -88), (41, -108, -26, -96)):
        key(p["upperarm.R"], f, x=up, z=out)
        key(p["forearm.R"], f, x=el)
        key(p["hand.R"], f, x=-12)
    # Shield arm stays up across the body the whole time.
    for (f, a, b) in ((1, -62, -74), (16, -54, -86), (22, -58, -80), (41, -62, -74)):
        key(p["upperarm.L"], f, x=a, z=-30)
        key(p["forearm.L"], f, x=b)
    for (f, l, r) in ((1, -14, 20), (10, -18, 26), (16, -30, 8), (22, -26, 12),
                      (32, -16, 22), (41, -14, 20)):
        key(p["thigh.L"], f, x=l)
        key(p["thigh.R"], f, x=r)
    # Positive is the way a knee bends, and the front leg is the bent one. The
    # back leg stays long, on the ball of the foot, which is what a stance is.
    for (f, l, r) in ((1, 22, 4), (16, 34, 12), (22, 30, 8), (41, 22, 4)):
        key(p["shin.L"], f, x=l)
        key(p["shin.R"], f, x=r)
    # Front sole flat on the ground (lean + thigh + shin + foot = 0), back heel
    # up with only the ball of it down, which is what a stance is.
    for (f, l, r) in ((1, -8, -10), (16, -13, -16), (22, -10, -14), (41, -8, -10)):
        key(p["foot.L"], f, x=l)
        key(p["foot.R"], f, x=r)
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
    anim_fight(arm)
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
