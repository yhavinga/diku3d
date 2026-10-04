"""bull -- the minotaurs' body, head and the clips only they have.

The Keep of Mahn-Tor and Wyvern's Tower have thirty minotaurs, and every one
of them is dressed: 'clad in heavy furs. Beneath these furs, you see the
gleam of his armor', 'blue plate armour', 'heavy red armor and wields a huge
glaive', 'loose robes', 'green and brown leather', 'clad all in black'. So a
minotaur is a person -- the people's rig, clips and clothes (people.py
builds the file `minotaur.glb` like `troll.glb`) -- on a body a size up from
a man's, broad in the chest and the neck, with a bull's head where the face
goes: horns, a long muzzle with wet nostrils, ears out to the sides, small
eyes set wide, and the jaw on the jaw bone so it opens with a bellow. No
prose gives one hooves or a nose ring, so it has neither.

Three clips beyond the people's, for motion.js's pastimes: `paw` (a foot
scraping the floor back, three times, head down to watch it), `snort` (the
head tossed up and shaken) and `charge` (head lowered, horns forward,
shoulders hunched, a foot pawing once -- what a minotaur does when you come
too close).

The head is built from blended solids the way beasts.py builds an animal,
in the people's world frame on the rig's head and jaw bones.
"""

import math
import importlib

import bpy
import numpy as np
from mathutils import Vector as V

import lib
import beasts as B

importlib.reload(B)

cone, ell = B.cone, B.ell


# A man's joints (so the people's clips and strides fit unchanged), with the
# girths of a much heavier one: the chest and the neck of a bull.
def body(MALE):
    return dict(
        MALE, name="minotaur", bull=True,
        shoulder=(0.215, 0.012, 1.445), arm_a=24.0,
        hips=(0.195, 0.125, 0.14), waist=(0.18, 0.125, 0.115), chest=(0.215, 0.15, 0.13),
        lats=0.225, neck=0.092, thigh=0.112, calf=0.078, knee_r=0.064, ankle_r=0.044,
        upper_r=0.07, elbow_r=0.052, wrist_r=0.039, delt=0.088,
        head=(0.09, 0.115, 0.125), jaw=0.07, chin=0.03, brow=1.6, nose=1.2,
        breasts=0.0, belly=0.4,
    )


def bulk(P, ellipsoid):
    """The bull's neck: a hump of muscle from the back of the skull down
    over the shoulders, and the dewlap under the jaw."""
    sz = P["shoulder"][2]
    hj = P["head_joint"]
    return [ellipsoid((0.0, P["chest"][2] * 0.35, sz + 0.05), (0.2, 0.12, 0.13), name="hump",
                      rot=(math.radians(-24), 0, 0)),
            ellipsoid((0.0, 0.01, hj - 0.06), (0.105, 0.1, 0.11), name="nape"),
            ellipsoid((0.0, -0.05, hj - 0.08), (0.07, 0.06, 0.08), name="dewlap")]


def _part(solids, h, tris, name, mat, bone):
    import rig
    verts, faces = B.surface_nets(solids, h)
    obj = B.mesh_from(verts, faces, name)
    B.decimate(obj, tris)
    B.relax(obj, solids, iterations=1)
    lib.assign(obj, mat)
    rig.set_rigid(obj, bone)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def face(P, name="face_minotaur"):
    """The bull's head, in the people's world frame (y back, z up), on the
    head bone; its lower jaw on the jaw bone. One object, several surfaces:
    skin (the coat, tinted per minotaur), bone (the horns), eye, hair (the
    tuft on the poll)."""
    import people
    hj = P["head_joint"]
    z = lambda u: hj + u
    skull = [
        ell((0, 0.01, z(0.11)), (0.1, 0.115, 0.105), "head", blend=0.04),
        # The poll and the broad flat brow between the horns.
        ell((0, -0.045, z(0.165)), (0.12, 0.06, 0.05), "head", blend=0.04),
        # The long face down to the muzzle, and the muzzle itself.
        cone((0, -0.07, z(0.13)), (0, -0.22, z(0.02)), 0.085, 0.068, "head", blend=0.05, squash=(0.82, 1, 1)),
        ell((0, -0.245, z(0.005)), (0.072, 0.055, 0.062), "head", blend=0.04),
        ell((0.06, -0.08, z(0.07)), (0.05, 0.06, 0.06), "head", blend=0.04),
        ell((-0.06, -0.08, z(0.07)), (0.05, 0.06, 0.06), "head", blend=0.04),
        # The neck it sits on, thick, into the nape the body carries.
        cone((0, 0.03, z(-0.09)), (0, -0.01, z(0.08)), 0.1, 0.095, "head", blend=0.06),
        # Nostrils, cut into the end of the muzzle.
        ell((0.027, -0.296, z(0.012)), (0.012, 0.012, 0.016), "head", blend=0.008, neg=True),
        ell((-0.027, -0.296, z(0.012)), (0.012, 0.012, 0.016), "head", blend=0.008, neg=True),
    ]
    out = [_part(skull, 0.007, 2000, "bull_head", "skin", "head")]
    jaw = [cone((0, -0.07, z(0.03)), (0, -0.23, z(-0.035)), 0.055, 0.045, "jaw", blend=0.02, squash=(0.9, 1, 0.7))]
    out.append(_part(jaw, 0.006, 260, "bull_jaw", "skin", "jaw"))
    for side in (1, -1):
        # Horns: out level from the poll, then up and forward to a point.
        pts = [V((side * 0.08, -0.03, z(0.175))), V((side * 0.2, -0.03, z(0.2))), V((side * 0.29, -0.06, z(0.27))),
               V((side * 0.31, -0.12, z(0.36)))]
        radii = [0.034, 0.026, 0.015, 0.004]
        horn = [cone(tuple(pts[i]), tuple(pts[i + 1]), radii[i], radii[i + 1], "head", blend=0.006, group="h")
                for i in range(3)]
        out.append(_part(horn, 0.004, 320, "horn", "bone", "head"))
        # Ears, flat leaves out to the side under the horns.
        ear = [cone((side * 0.1, 0.0, z(0.13)), (side * 0.19, 0.02, z(0.1)), 0.028, 0.012, "head", blend=0.01,
                    squash=(1, 0.32, 1))]
        out.append(_part(ear, 0.0035, 120, "ear", "skin", "head"))
        eye = [ell((side * 0.078, -0.115, z(0.12)), (0.014, 0.017, 0.013), "head", blend=0.004)]
        out.append(_part(eye, 0.0025, 70, "eye", "eye", "head"))
    # A curled tuft on the poll, between the horns.
    tuft = [ell((x, -0.06 + 0.01 * abs(x) * 10, z(0.205 - abs(x))), (0.03, 0.035, 0.022), "head", blend=0.012)
            for x in (-0.04, 0.0, 0.04)]
    out.append(_part(tuft, 0.004, 260, "tuft", "hair", "head"))
    obj = people.join(out, name)
    obj.data.name = name
    return obj


# --- clips ------------------------------------------------------------------


def _foot(arm, f, tag, dx=0.0, dy=0.0, up=0.0, pitch=0.0, yaw=-6.0):
    import rig
    a = rig.rest_ankle(arm, tag) + V((dx, dy, up))
    rig.place(arm, "foot_ik." + tag, f, rig.foot_matrix(arm, tag, a, pitch, yaw))


def anim_paw(arm):
    """A foot raised and dragged back over the floor, three times, the head
    down to watch it and the shoulders working: a bull before it charges."""
    import rig
    head = rig.merge(rig.HANG, {"spine": (6, 0, 0), "chest": (6, 0, 0), "neck": (14, 0, 0), "head": (18, 0, 0),
                                "upperarm.L": (-6, 0, -10), "upperarm.R": (-6, 0, 10)})
    rig.new_action(arm, "paw")
    keys = [(1, 0.0, 0.0, 0.0), (8, -0.16, 0.06, 20.0), (16, 0.14, 0.0, -10.0), (24, -0.16, 0.06, 20.0),
            (32, 0.14, 0.0, -10.0), (40, -0.16, 0.06, 20.0), (48, 0.14, 0.0, -10.0), (58, 0.0, 0.0, 0.0)]
    for (f, dy, up, pitch) in keys:
        k = 0.0 if f in (1, 58) else 1.0
        rig.pose(arm, f, rig.blend(rig.HANG, head, k), ((0.0, 0.0, -0.01 * k), 3 * k, 0.0, -2 * k), "rest")
        _foot(arm, f, "R", dx=-0.004, dy=dy, up=up, pitch=pitch)
    return "paw", (1, 58)


def anim_snort(arm):
    """The head flung up and back with a blast through the nostrils, shaken,
    and brought down again."""
    import rig
    rig.new_action(arm, "snort")
    keys = [(1, 0, 0, 0), (7, -16, 0, 4), (11, -24, 10, 6), (15, -18, -10, 6), (19, -20, 8, 4), (26, -6, 0, 2), (36, 0, 0, 0)]
    for (f, toss, shake, shrug) in keys:
        b = rig.merge(rig.HANG, {"chest": (toss * 0.15, 0, 0), "neck": (toss * 0.4, shake * 0.4, 0),
                                 "head": (toss * 0.6, shake * 0.6, 0),
                                 "upperarm.L": (2, 0, -4 - shrug), "upperarm.R": (2, 0, 4 + shrug)})
        rig.pose(arm, f, b, ((0.0, 0.0, -0.004), 0.0, 0.0, 0.0), "rest")
    return "snort", (1, 36)


def anim_charge(arm):
    """Head down and the horns levelled at you, the shoulders hunched up
    round it, arms out from the body, a foot pawing once -- held -- and
    up again."""
    import rig
    low = rig.merge(rig.HANG, {"spine": (14, 0, 0), "chest": (12, 0, 0), "neck": (26, 0, 0), "head": (26, 0, 0),
                               "shoulder.L": (0, 0, 12), "shoulder.R": (0, 0, -12),
                               "upperarm.L": (-18, 0, -26), "upperarm.R": (-18, 0, 26),
                               "forearm.L": (-45, 0, 0), "forearm.R": (-45, 0, 0)})
    rig.new_action(arm, "charge")
    keys = [(1, 0.0, 0.0, 0.0, 0.0), (10, 1.0, 0.0, 0.0, 0.0), (16, 1.0, -0.14, 0.06, 20.0), (22, 1.0, 0.16, 0.0, -10.0),
            (28, 1.0, 0.0, 0.0, 0.0), (44, 1.0, 0.0, 0.0, 0.0), (56, 0.0, 0.0, 0.0, 0.0)]
    for (f, k, dy, up, pitch) in keys:
        rig.pose(arm, f, rig.blend(rig.HANG, low, k), ((0.0, 0.03 * k, -0.06 * k), 8 * k, 0.0, 0.0), "rest")
        _foot(arm, f, "R", dx=-0.004, dy=dy, up=up, pitch=pitch)
    return "charge", (1, 56)


CLIPS = (anim_paw, anim_snort, anim_charge)
