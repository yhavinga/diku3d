"""creatures -- the Hatchet Mud School's menagerie, built to the deer's standard.

The arena under the school keeps a rabbit, a lizard, a boar, a fox and a
handful of snails, and the dungeon below it a bear, a wolf and "the beast";
the cages hold a blob. The mammals that the library already had (the boar on
the pig, the fox and the wolf on the canine, the bear) are proportioned in the
viewer. What is built here is what had no body of its own and was being drawn
as a townsperson in a tunic -- a lizard, a snail, a blob, the beast -- and a
rabbit, which is not a rat with long ears: it sits on long hind feet and goes
everywhere in hops.

Every animal is made the way beasts.py makes a dog: blended solids sampled
into one skin, weighted from the same solids, masks in the vertex colours.
What each one does when it is not going anywhere is part of the model, as
clips of its own beside `idle`: a lizard basks flat on the floor and does
push-ups, a rabbit nibbles, washes its face and sits up to look round, a snail
waves its eye-stalks and draws them in. motion.js plays them the way it plays
the deer's `graze` (its PASTIMES table), so a rig only has to carry them.

Blender is Z-up; every creature faces -Y with its left side +X, the ground at
z = 0, and specs are written in (side, forward, up) like beasts.py's.
"""

import json
import math
import importlib

import bpy
import mathutils
import numpy as np

import lib
import beasts as B
import monsters as M

importlib.reload(lib)
importlib.reload(B)
importlib.reload(M)

V = mathutils.Vector
P = B.P
cone, ell = B.cone, B.ell
ease, lerp, wave = B.ease, B.lerp, B.wave
FPS = B.FPS


def bump(t, c, w):
    """A smooth pulse at t = c, about w wide, looping on [0, 1)."""
    d = (t - c + 0.5) % 1.0 - 0.5
    return math.exp(-(d / w) ** 2)


def hold_steps(t, keys, snap=0.04):
    """A value that jumps between held levels the way a lizard moves its head:
    still, then a quick turn, then still. keys = [(t0, value), ...] sorted,
    looping (the last level runs back round to the first)."""
    out = keys[-1][1]
    prev = keys[-1][1]
    for (t0, v) in keys:
        if t >= t0:
            k = ease((t - t0) / snap)
            out = lerp(prev, v, k)
        prev = v if t >= t0 else prev
    return out


def key_locations(arm, frames, fn, step=1):
    """Location keys on non-root bones in the action being built: the Poser
    keys rotations only below the root. `fn(t)` -> {bone: Vector in the bone's
    own frame}. Used for a tongue that slides out of a mouth."""
    pbs = arm.pose.bones
    for i in list(range(0, frames, step)) + [frames]:
        for name, loc in fn(i / frames).items():
            pbs[name].location = loc
            pbs[name].keyframe_insert("location", frame=i)
    for fc in B.action_fcurves(arm.animation_data.action):
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"


def limb(pts, base, side, radii, blend, mask_low=0.0, squash=None):
    """An arthro leg (monsters.splay_leg landmarks) as part of the body's own
    surface: round cones joint to joint, joined hard among themselves and
    blended into the flank as one, so the thigh grows out of the body
    instead of butting against it as a separate tube with an end on it."""
    tag = ".L" if side > 0 else ".R"
    q = [B.apply_side(p, side) for p in pts]
    out = []
    for i, seg in enumerate(("femur", "tibia", "meta", "tarsus")):
        nm = "%s%s%s" % (seg, base, tag)
        out.append(cone(P(*q[i]), P(*q[i + 1]), radii[i], radii[i + 1], nm, blend=blend,
                        mask=(0, mask_low * i / 3.0), group="leg%s%s" % (base, tag), squash=squash))
    return out


# ============================================================ the lizard


LIZARD_WALK = {"leg1.L": 0.0, "leg2.R": 0.06, "leg1.R": 0.5, "leg2.L": 0.56}


def lizard():
    """school.are's lizard 'slithers up to you ... smiles at you, and tries to
    eat your leg': a big one, then -- a monitor's build, a metre and a half
    from snout to tail tip and knee-high to nobody. Low and long, the belly a
    hand off the floor; four sprawling legs, the upper arm and thigh carried
    out sideways and the forearm and shin straight down to a flat foot with
    long clawed toes; a long wedge of a head with the mouth running back past
    the eye (the smile), a forked tongue, a loose throat, and a tail longer
    than the rest of it, thick at the root."""
    tail = [(0, -0.17, 0.112), (0, -0.31, 0.1), (0, -0.46, 0.082), (0, -0.61, 0.062), (0, -0.76, 0.044),
            (0, -0.9, 0.028), (0, -1.02, 0.018)]
    tn = ["tail%d" % (i + 1) for i in range(len(tail) - 1)]
    legs = {
        # Front: out and a little forward from the shoulder, the elbow at the
        # shoulder's height, the forearm straight down to the wrist.
        "1": (M.splay_leg((0.055, 0.29), 72, 0.23, 0.13, 0.03, 0.009, 0.105, frac=(0.5, 0.6, 0.75)), "chest"),
        # Hind: out and back from the hip, the knee up above it.
        "2": (M.splay_leg((0.06, -0.08), 110, 0.26, 0.125, 0.032, 0.009, 0.105, frac=(0.5, 0.62, 0.76)), "pelvis"),
    }
    root = ("body", (0, -0.04, 0.118), (0, 0.15, 0.122))
    extra = [("chest", (0, 0.15, 0.122), (0, 0.34, 0.128), "body"),
             ("neck", (0, 0.34, 0.128), (0, 0.43, 0.142), "chest"),
             ("head", (0, 0.43, 0.142), (0, 0.6, 0.112), "neck"),
             ("jaw", (0, 0.45, 0.112), (0, 0.595, 0.098), "head"),
             ("tongue", (0, 0.5, 0.11), (0, 0.585, 0.104), "jaw"),
             ("pelvis", (0, -0.04, 0.118), tail[0], "body")]
    par = "pelvis"
    for i, nm in enumerate(tn):
        extra.append((nm, tail[i], tail[i + 1], par))
        par = nm
    trunk = ("grad", "body", "chest", P(0, 0.02, 0.12), P(0, 0.3, 0.12))
    body = [
        # The trunk: wider than it is deep, sagging a little between the girdles.
        ell(P(0, 0.1, 0.118), (0.092, 0.24, 0.062), trunk, blend=0.05),
        ell(P(0, 0.28, 0.125), (0.074, 0.1, 0.058), "chest", blend=0.04),
        ell(P(0, -0.07, 0.112), (0.078, 0.12, 0.056), ("grad", "pelvis", "body", P(0, -0.15, 0.11), P(0, 0.02, 0.12)), blend=0.045),
        # Neck: thick, with the loose throat hanging under it.
        cone(P(0, 0.33, 0.128), P(0, 0.44, 0.14), 0.056, 0.046, ("grad", "chest", "neck", P(0, 0.33, 0.13), P(0, 0.43, 0.14)), blend=0.035,
             squash=(1.0, 1.0, 0.9)),
        ell(P(0, 0.4, 0.105), (0.04, 0.07, 0.03), ("grad", "neck", "jaw", P(0, 0.36, 0.1), P(0, 0.48, 0.1)), blend=0.03),
        # Head: broad behind the eyes where the jaw muscles are, flat on top,
        # tapering to a blunt snout.
        ell(P(0, 0.47, 0.14), (0.056, 0.064, 0.038), "head", blend=0.025),
        cone(P(0, 0.48, 0.138), P(0, 0.595, 0.118), 0.046, 0.022, "head", blend=0.02, squash=(1.0, 1.0, 0.62)),
        # Brows over the eyes.
        ell(P(0.028, 0.5, 0.152), (0.016, 0.026, 0.01), "head", blend=0.012),
        ell(P(-0.028, 0.5, 0.152), (0.016, 0.026, 0.01), "head", blend=0.012),
    ]
    for i, nm in enumerate(tn):
        r0 = 0.058 * (1 - i / len(tn)) ** 1.1 + 0.006
        r1 = 0.058 * (1 - (i + 1) / len(tn)) ** 1.1 + 0.006
        # Deeper than it is wide over the second half, a swimmer's tail.
        sq = (1.0 - 0.15 * min(1.0, i / 3.0), 1.0, 1.0)
        body.append(cone(P(*tail[i]), P(*tail[i + 1]), r0, r1, nm, blend=0.03, group="tail", squash=sq))

    for base, (pts, _) in legs.items():
        for side in (1, -1):
            r = [0.034, 0.025, 0.019, 0.014, 0.007] if base == "1" else [0.044, 0.029, 0.021, 0.015, 0.007]
            body += limb(pts, base, side, r, 0.022, mask_low=0.15)

    def masks(co, n, pale, dark):
        f = -co[:, 1]
        belly = np.clip((-n[:, 2] - 0.15) / 0.45, 0, 1)
        # A darker back and a banded tail: the patch channel is the speckle.
        back = np.clip((n[:, 2] - 0.55) / 0.35, 0, 1)
        bands = (np.sin((f + 0.2) * 34.0) > 0.35) * (f < -0.2) * 0.55
        throat = np.clip((-n[:, 2] + 0.2) / 0.5, 0, 1) * (f > 0.34) * (f < 0.5)
        return np.maximum(pale, np.maximum(belly, throat * 0.8)), np.maximum(dark, np.maximum(back * 0.35, bands))

    def parts(body_solids):
        out = []
        # Toes: five long fingers fanned on every foot, claws at their tips.
        toes, claws = [], []
        for base, (pts, _) in legs.items():
            for side, tag in ((1, ".L"), (-1, ".R")):
                q = [V(B.apply_side(p, side)) for p in pts]
                wrist, tip = q[3], q[4]
                d = tip - wrist
                d.z = 0
                d.normalize()
                bone = "tarsus%s%s" % (base, tag)
                for k in range(5):
                    a = math.radians(-50 + 25 * k) * (1 if side > 0 else -1)
                    dd = V((d.x * math.cos(a) - d.y * math.sin(a), d.x * math.sin(a) + d.y * math.cos(a), 0))
                    ln = (0.045 if base == "1" else 0.06) * (0.65 + 0.35 * math.sin(math.pi * (k + 0.5) / 5))
                    a0 = wrist + V((0, 0, 0.004))
                    a1 = a0 + dd * ln
                    toes.append(cone(P(*a0), P(a1.x, a1.y, 0.006), 0.0075, 0.0045, bone, blend=0.004, group="t%s%d" % (tag, k)))
                    claws.append(cone(P(a1.x, a1.y, 0.006), P(*(a1 + dd * 0.016 + V((0, 0, -0.004)))), 0.004, 0.0012, bone,
                                      blend=0.001, group="c%s%d" % (tag, k)))
        out.append(B.sdf_part(toes, 0.0025, 900, "toes", "hide", smooth=1, mask_fn=lambda co, n, p, d: (p, d + 0.2)))
        out.append(B.solid_part(claws, 0.0015, 400, "claws", "horn", (0.12, 0.1, 0.08), smooth=0))
        # The lower jaw, and the line of the mouth running back past the eye:
        # what makes a lizard look as if it is smiling.
        jaw = [cone(P(0, 0.46, 0.113), P(0, 0.59, 0.1), 0.036, 0.016, "jaw", blend=0.012, squash=(1.0, 1.0, 0.5))]
        out.append(B.sdf_part(jaw, 0.003, 300, "jaw", "hide", smooth=1, mask_fn=lambda co, n, p, d: (np.maximum(p, 0.6), d)))
        mouth = [ell(P(0, 0.52, 0.116), (0.035, 0.075, 0.006), {"head": 0.5, "jaw": 0.5}, blend=0.004)]
        out.append(B.solid_part(mouth, 0.002, 160, "mouth", "horn", (0.42, 0.16, 0.15)))
        # The tongue: forked, slate blue, lying in the floor of the mouth; the
        # clips slide it out along its bone.
        tongue = [cone(P(0, 0.5, 0.111), P(0, 0.575, 0.106), 0.006, 0.004, "tongue", blend=0.002)]
        for s in (1, -1):
            tongue.append(cone(P(0, 0.572, 0.106), P(s * 0.007, 0.592, 0.105), 0.0035, 0.0012, "tongue", blend=0.001,
                               group="f%d" % s))
        out.append(B.solid_part(tongue, 0.0012, 160, "tongue", "horn", (0.16, 0.17, 0.24), smooth=0))
        # Eyes: high on the sides of the head under the brows, gold with a
        # dark pupil reading as one dark bead at any distance.
        out += B.eye_pair(body_solids, (0.09, 0.505, 0.143), (-1.0, 0.0, -0.05), 0.0095, colour=(0.32, 0.22, 0.04),
                          sink=0.003, h=0.0015, tris=80)
        # Nostrils.
        nos = []
        for s in (1, -1):
            at = B.surface_point(body_solids, P(s * 0.012, 0.66, 0.13), P(0, -1, -0.2), sink=0.002)
            nos.append(ell(tuple(at), (0.004, 0.004, 0.003), "head", blend=0.0))
        out.append(B.solid_part(nos, 0.001, 60, "nostril", "horn", (0.03, 0.025, 0.02), smooth=0))
        return out

    return dict(name="beast_lizard", archetype="lizard", body=body, masks=masks, parts=parts,
                patch=B.spots(0.025, seed=131), h=0.0045, tris=3600, mat="hide",
                bones=M.arthro_bones(root, extra, legs), legs=M.arthro_legs(legs), root="body",
                clips=lizard_clips, legtop=0.2, tail=tn,
                gait=dict(walk_stride=0.26, walk_frames=20, walk_duty=0.68, lift=0.045, bend=-13.0,
                          run_stride=0.38, run_frames=10, run_duty=0.48, run_bend=-16.0))


def lizard_clips(arm, spec):
    """idle, walk, run, attack, hit, death -- and two things a lizard does
    when it has nowhere to be: `bask`, flat out on the floor with its legs
    sprawled and its chin down, and `display`, the push-ups, the chest jacked
    up off straightened forelegs three times and the head bobbing with it.

    Its walk is a sprawler's: diagonal legs in pairs (left fore with right
    hind), and the trunk swinging from side to side in a standing wave, so
    the shoulder of the leg reaching forward is carried forward with it. The
    head is held steady against the swing, and the tail follows it a beat
    behind."""
    g = spec["gait"]
    poser = M.ArthroPoser(arm, spec["legs"])
    rest = M.arthro_rest(poser)
    clip = B.Clip(poser)
    tn = spec["tail"]
    height = poser.rest["body"].translation.z
    track = {leg: poser.legs[leg]["chain"][3] for leg in poser.legs}
    report = {}
    flat = {leg: M.foot_at(rest, leg) for leg in rest}

    def spine(t, amp, lag=0.1):
        """The standing wave: a C one way and then the other, the girdles
        turning opposite ways (a positive yaw turns any bone to the animal's
        right), the head held against it and the tail a beat behind."""
        c = math.cos(2 * math.pi * t)
        fk = {"chest": (0, amp * 0.6 * c, 0), "body": (0, amp * 0.5 * c, 0),
              "pelvis": (0, amp * 0.9 * c, 0),
              "neck": (0, -amp * 0.75 * c, 0), "head": (0, -amp * 0.35 * c, 0)}
        for i, nm in enumerate(tn):
            fk[nm] = (0, -amp * 0.55 * math.cos(2 * math.pi * (t - lag * (i + 1))), 0)
        return fk

    def tongue_at(t, flicks):
        out = 0.0
        for c in flicks:
            out = max(out, bump(t, c, 0.012))
        return out

    # -- idle: breathing, the head still and then snapping round to a new
    # look and holding it, the tongue out twice in quick succession now and
    # then, the tail tip curling.
    IDLE = 180
    idle_flicks = (0.18, 0.215, 0.62, 0.655, 0.69)

    def idle(t):
        breath = wave(3 * t)
        look = hold_steps(t, [(0.05, 18.0), (0.33, -6.0), (0.5, -22.0), (0.78, 4.0), (0.94, 0.0)])
        tilt = hold_steps(t, [(0.05, -4.0), (0.33, 2.0), (0.5, -2.0), (0.78, 4.0), (0.94, 0.0)])
        fk = {"body": (0.6 * breath, 0, 0), "chest": (-0.5 * breath, 0, 0),
              "neck": (-4 + tilt * 0.4, look * 0.55, 0), "head": (tilt, look * 0.45, look * 0.08),
              "jaw": (-3 * tongue_at(t, idle_flicks), 0, 0)}
        for i, nm in enumerate(tn):
            fk[nm] = (-1.5 if i < 2 else 0.5, 3 * wave(t, -0.08 * i) + (10 * wave(t, 0.3) if i >= len(tn) - 2 else 0), 0)
        return dict(fk=fk, loc=V((0, 0, 0.002 * breath)), ik=flat)
    clip.run("idle", IDLE, idle, step=2)
    key_locations(arm, IDLE, lambda t: {"tongue": V((0, 0.075 * tongue_at(t, idle_flicks), 0))})

    # -- walk.
    S, N, duty, lift = g["walk_stride"], g["walk_frames"], g["walk_duty"], g["lift"]

    def walk(t):
        ik = M.arthro_gait(rest, t, S, duty, lift, LIZARD_WALK, tuck=10.0)
        fk = spine(t, g["bend"])
        fk["body"] = (0, fk["body"][1], 1.5 * wave(t, 0.25))
        fk["jaw"] = (0, 0, 0)
        return dict(fk=fk, loc=V((0, 0, 0.003 * wave(2 * t, 0.2))), ik=ik)
    tracks = clip.run("walk", N, walk, track=track)
    report["walk"] = M.arthro_slip(tracks, S, N, duty, LIZARD_WALK)
    key_locations(arm, N, lambda t: {"tongue": V((0, 0, 0))})

    # -- run: up on its legs, the body carried higher and the swing wider.
    S2, N2, duty2 = g["run_stride"], g["run_frames"], g["run_duty"]

    def run(t):
        ik = M.arthro_gait(rest, t, S2, duty2, lift * 1.5, LIZARD_WALK, tuck=16.0)
        fk = spine(t, g["run_bend"], lag=0.08)
        fk["neck"] = (-6, fk["neck"][1], 0)
        fk["head"] = (4, fk["head"][1], 0)
        for i, nm in enumerate(tn):
            fk[nm] = (-3 if i < 3 else 0, fk[nm][1], 0)
        return dict(fk=fk, loc=V((0, 0, height * 0.04 + 0.004 * wave(2 * t, 0.2))), ik=ik)
    tracks = clip.run("run", N2, run, track=track)
    report["run"] = M.arthro_slip(tracks, S2, N2, duty2, LIZARD_WALK)
    key_locations(arm, N2, lambda t: {"tongue": V((0, 0, 0))})

    # -- attack: a crouch, a lunge at ankle height with the jaws wide, and a
    # shake of the head on the bite.
    HIT = 0.45

    def attack(t):
        crouch = ease(t / 0.25) * (1 - ease((t - 0.28) / 0.1))
        lunge = ease((t - 0.28) / 0.15) * (1 - ease((t - 0.62) / 0.38))
        gape = ease((t - 0.22) / 0.12) * (1 - ease((t - 0.44) / 0.05))
        shake = 18 * math.sin(2 * math.pi * 3.0 * max(0.0, t - 0.45)) * (1 - ease((t - 0.45) / 0.3)) * (t > 0.45)
        fk = {"body": (-4 * lunge, 0, 0), "chest": (2 * crouch - 6 * lunge, 0, 0),
              "neck": (6 * crouch - 12 * lunge, shake * 0.6, 0), "head": (-10 * gape - 4 * lunge, shake * 0.4, shake * 0.3),
              "jaw": (-40 * gape, 0, 0)}
        for i, nm in enumerate(tn):
            fk[nm] = (0, 8 * wave(t, -0.1 * i) * lunge, 0)
        ik = {leg: M.foot_at(rest, leg) for leg in rest}
        loc = V((0, -0.16 * lunge + 0.03 * crouch, -0.025 * crouch + 0.02 * lunge))
        return dict(fk=fk, loc=loc, ik=ik)
    clip.run("attack", 24, attack)
    key_locations(arm, 24, lambda t: {"tongue": V((0, 0, 0))})

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.3)) if t < 0.3 else (1 - ease((t - 0.3) / 0.7)) * 0.85
        fk = {"body": (0, -6 * k, 0), "chest": (-4 * k, -8 * k, 0), "neck": (-10 * k, 14 * k, 0), "head": (-8 * k, 6 * k, 0),
              "jaw": (-12 * k, 0, 0)}
        for i, nm in enumerate(tn):
            fk[nm] = (0, 14 * k * (1 - i / len(tn)), 0)
        return dict(fk=fk, loc=V((0.02 * k, 0.04 * k, 0.015 * k)), ik=flat)
    clip.run("hit", 12, hit)
    key_locations(arm, 12, lambda t: {"tongue": V((0, 0, 0))})

    # -- death: a convulsion, then over onto its back with the legs curled
    # up into the air, which is how a dead lizard is recognised anywhere.
    def death(t):
        twist = ease((t - 0.15) / 0.45)
        curl = ease((t - 0.3) / 0.5)
        thrash = 12 * math.sin(2 * math.pi * 4 * t) * (1 - ease(t / 0.35))
        rot = mathutils.Quaternion(V((0, 1, 0)), math.radians(-172 * twist))
        fk = {"chest": (0, thrash, 0), "neck": (8 * curl, -thrash + 15 * curl, 0), "head": (14 * curl, 10 * curl, 0),
              "jaw": (-14 * curl, 0, 0)}
        for i, nm in enumerate(tn):
            fk[nm] = (0, thrash * 0.8 + 6 * curl, 0)
        # Limp: the legs leave the floor as it goes over and fold in towards
        # the belly, which is now the sky.
        for leg, info in poser.legs.items():
            up_, lo_, meta_, toe_ = info["chain"]
            fk[up_] = (-35 * curl, 0, 0)
            fk[lo_] = (-50 * curl, 0, 0)
            fk[meta_] = (-30 * curl, 0, 0)
            fk[toe_] = (-20 * curl, 0, 0)
        ik = {leg: M.foot_at(rest, leg) for leg in rest}
        # Belly up, the back on the floor: the spine was 0.12 m up with
        # 6 cm of body over it, so it comes down to 6 cm.
        loc = V((0, 0, -0.065 * twist + 0.03 * math.sin(math.pi * twist)))
        return dict(fk=fk, loc=loc, rot=rot, ik=ik, limp=ease((t - 0.1) / 0.3))
    clip.run("death", 40, death)
    key_locations(arm, 40, lambda t: {"tongue": V((0, 0.06 * ease((t - 0.5) / 0.3), 0))})

    # -- bask: belly down on the warm floor, legs sprawled further out, the
    # chin down and the tail lying slack. A loop that starts and ends in the
    # same pose so the viewer can hold it.
    def bask(t):
        breath = wave(2 * t)
        fk = {"body": (0.5 * breath, 0, 0), "chest": (1.5, 0, 0), "neck": (6, 3 * wave(t, 0.2), 0), "head": (-3, 0, 0),
              "jaw": (0, 0, 0)}
        for i, nm in enumerate(tn):
            fk[nm] = (-2 if i < 2 else 0, 4 * math.sin(math.pi * (i + 1) / len(tn)), 0)
        ik = {leg: M.foot_at(rest, leg, out=0.05, am=12, at=8) for leg in rest}
        return dict(fk=fk, loc=V((0, 0, -0.054 + 0.002 * breath)), ik=ik)
    clip.run("bask", 120, bask, step=2)
    key_locations(arm, 120, lambda t: {"tongue": V((0, 0, 0))})

    # -- display: the push-ups. Three quick presses over the first half,
    # then still with the chest up, then down again.
    def display(t):
        up = ease(t / 0.08) * (1 - ease((t - 0.82) / 0.15))
        press = 0.0
        for c in (0.16, 0.3, 0.44):
            press = max(press, bump(t, c, 0.05))
        lift = 0.045 * up + 0.03 * press
        fk = {"body": (-7 * up - 5 * press, 0, 0), "chest": (-6 * up - 3 * press, 0, 0),
              "neck": (-8 * up + 10 * press, 0, 0), "head": (6 * up - 12 * press, 0, 0), "jaw": (0, 0, 0)}
        for i, nm in enumerate(tn):
            fk[nm] = (-1, 2 * wave(t, -0.1 * i), 0)
        # The forelegs straighten under the chest; the hind feet stay put.
        ik = {leg: M.foot_at(rest, leg, out=-0.02 * up if leg.startswith("leg1") else 0.0) for leg in rest}
        return dict(fk=fk, loc=V((0, 0, lift)), ik=ik)
    clip.run("display", 90, display)
    key_locations(arm, 90, lambda t: {"tongue": V((0, 0, 0))})

    report["clips"] = clip.report
    report["stride"] = {"walk": S, "run": S2}
    report["overreach"] = clip.reach
    report["hit"] = HIT
    return report


# ============================================================ the rabbit


HOP = {"hind.L": 0.0, "hind.R": 0.03, "fore.L": 0.5, "fore.R": 0.58}


def rabbit():
    """'A rabbit is bouncing around here. The rabbit smiles at you, completely
    harmless!' -- so it hops. A wild rabbit, 0.4 m nose to scut, crouched on
    long hind feet that lie flat on the ground from heel to toe, the haunches
    the biggest thing about it, a rounded back, small forepaws under the
    chest, a blunt face with big dark eyes high on the sides, long ears
    carried up and back, and a white scut. Built crouched, the way it sits."""
    L = dict(
        spine=[(0, -0.125, 0.105), (0, -0.045, 0.14), (0, 0.045, 0.133), (0, 0.1, 0.118)],
        neck=[(0, 0.1, 0.118), (0, 0.135, 0.152)],
        nose=(0, 0.222, 0.13),
        jaw=[(0, 0.15, 0.124), (0, 0.205, 0.112)],
        tail=[(0, -0.165, 0.095), (0, -0.195, 0.108)],
        hind=[(0.042, -0.09, 0.088), (0.05, -0.035, 0.052), (0.046, -0.135, 0.022),
              (0.043, -0.05, 0.007), (0.042, -0.022, 0.003)],
        fore=[(0.032, 0.078, 0.09), (0.03, 0.06, 0.054), (0.029, 0.08, 0.018),
              (0.028, 0.09, 0.006), (0.028, 0.106, 0.002)],
        scapula=(0.026, 0.05, 0.128),
        extra={"ear*": ((0.016, 0.142, 0.178), (0.032, 0.112, 0.268), "head")},
    )
    body = [
        # Haunches: a rabbit is mostly its back half.
        ell(P(0, -0.075, 0.1), (0.066, 0.092, 0.078), ("grad", "pelvis", "spine", P(0, -0.12, 0.1), P(0, -0.02, 0.12)), blend=0.03),
        ell(P(0, 0.035, 0.105), (0.052, 0.07, 0.06), ("grad", "spine", "chest", P(0, 0.0, 0.11), P(0, 0.08, 0.11)), blend=0.03),
        cone(P(0, 0.09, 0.115), P(0, 0.14, 0.148), 0.04, 0.034, ("grad", "chest", "neck", P(0, 0.09, 0.115), P(0, 0.135, 0.148)), blend=0.025),
        # Head: round cranium, deep cheeks, a short blunt muzzle with a split lip.
        ell(P(0, 0.158, 0.15), (0.034, 0.045, 0.036), "head", blend=0.02),
        ell(P(0, 0.17, 0.135), (0.036, 0.032, 0.03), "head", blend=0.018),
        cone(P(0, 0.17, 0.142), P(0, 0.214, 0.13), 0.026, 0.016, "head", blend=0.014, squash=(1.0, 1.0, 0.95)),
        # The scut, cocked up.
        ell(P(0, -0.178, 0.112), (0.02, 0.022, 0.024), "tail1", blend=0.012, mask=(0.95, 0)),
    ]
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += B.leg_solids(L, "hind", [0.02, 0.014, 0.011, 0.01, 0.006], 0.014, side)
        body += B.leg_solids(L, "fore", [0.015, 0.011, 0.0085, 0.0075, 0.005], 0.012, side)
        # The great thigh, and the long hind foot as a pad on the ground.
        body.append(ell(P(side * 0.045, -0.07, 0.072), (0.028, 0.06, 0.048), "thigh" + t, blend=0.02))
        body.append(ell(P(side * 0.044, -0.085, 0.008), (0.012, 0.055, 0.007), "hock" + t, blend=0.008, mask=(0.5, 0)))
        body.append(ell(P(side * 0.028, 0.096, 0.005), (0.009, 0.015, 0.0055), "ftoe" + t, blend=0.006, mask=(0.4, 0)))

    def masks(co, n, pale, dark):
        f = -co[:, 1]
        u = co[:, 2]
        under = np.clip((-n[:, 2] - 0.2) / 0.5, 0, 1) * (u < 0.11)
        # A pale throat and chin, a pale ring round the eye.
        chin = np.clip((-n[:, 2] + 0.3) / 0.5, 0, 1) * (f > 0.13) * (u < 0.14)
        # The nape and the ear backs darker.
        return np.maximum(pale, np.maximum(under, chin * 0.8)), dark

    def parts(body_solids):
        out = []
        tip = B.surface_point(body_solids, P(0, 0.26, 0.135), P(0, -1, 0))
        out.append(B.solid_part([ell(tuple(tip + V((0, 0.002, 0.0))), (0.007, 0.004, 0.005), "head", blend=0.002)],
                                0.001, 60, "nose", "horn", (0.5, 0.33, 0.32)))
        # Big dark eyes, high on the sides of the head.
        out += B.eye_pair(body_solids, (0.06, 0.168, 0.155), (-0.95, -0.1, -0.1), 0.0085, colour=(0.025, 0.018, 0.015),
                          sink=0.003, h=0.0012, tris=80)
        # Ears: long, cupped forward, dark-rimmed at the tip.
        out += B.leaf_pair(L, "ear", 0.02, 0.015, (1.0, 0.3, 1.0), 0.0016, tris=200, mask=(0.25, 0.45))
        # Whiskers would be lost at any distance; the incisors are not.
        teeth = [cone(P(s * 0.003, 0.205, 0.121), P(s * 0.003, 0.206, 0.116), 0.0026, 0.0024, "head", blend=0.001,
                      group="i%d" % (s > 0)) for s in (1, -1)]
        out.append(B.solid_part(teeth, 0.001, 60, "teeth", "horn", (0.82, 0.78, 0.66), smooth=0))
        return out

    return dict(name="beast_rabbit", archetype="lagomorph", L=L, body=body, masks=masks, parts=parts,
                patch=lambda co: np.zeros(len(co)), h=0.0022, tris=2600, clips=rabbit_clips,
                gait=dict(walk_stride=0.26, walk_frames=14, walk_duty=0.42, lift=0.035,
                          run_stride=0.8, run_frames=12, run_duty=0.26, run_lift=0.06))


def rabbit_clips(arm, spec):
    """A rabbit's day: crouched, nose twitching, ears turning on their own;
    `nibble`, head down at the grass; `groom`, back on its haunches washing
    its face with both forepaws; `situp`, up on its hind legs to look round
    over whatever is in the way, ears straight up. It moves in hops -- both
    hind feet landing together ahead of the forepaws, which come down one
    after the other -- and runs in long bounds with the body stretched out
    in the air between."""
    g = spec["gait"]
    poser = B.Poser(arm, B.quad_legs())
    rest = B.leg_rest(poser)
    clip = B.Clip(poser)
    bones = {b.name for b in arm.data.bones}
    report = {}
    flat = {leg: B.planted(rest, leg) for leg in rest}
    height = rest["fore.L"]["hip"].z

    def track_of():
        return {leg: poser.legs[leg]["chain"][3] for leg in poser.legs}

    def ears(t, l=0.0, r=0.0, back=0.0):
        # Ears turn independently: positive pitch lays one back.
        return {"ear.L": (back + l, 0, 6 * l / 20), "ear.R": (back + r, 0, -6 * r / 20)}

    # -- idle: crouched; the nose going (a jaw-and-head flutter at 4 Hz),
    # an ear swivelling now and then, a look round.
    def idle(t):
        breath = wave(5 * t)
        twitch = 1.2 * wave(24 * t) * (0.6 + 0.4 * wave(2 * t))
        look = hold_steps(t, [(0.1, 14.0), (0.42, -10.0), (0.7, 0.0)], snap=0.05)
        fk = {"chest": (0.6 * breath, 0, 0), "spine": (-0.4 * breath, 0, 0),
              "neck": (0, look * 0.5, 0), "head": (twitch, look * 0.5, 0), "jaw": (-1.5 * max(0.0, twitch), 0, 0)}
        fk.update(ears(t, l=-14 * bump(t, 0.3, 0.05), r=-12 * bump(t, 0.62, 0.05), back=4))
        fk["tail1"] = (0, 0, 0)
        return dict(fk=fk, loc=V((0, 0, 0.001 * breath)), ik=flat)
    clip.run("idle", 120, idle, step=2)

    # -- walk: the hop. Hind feet together, then the forepaws one after the
    # other; the back rounds as the hind feet come up under it and stretches
    # as they push off.
    S, N, duty, lift = g["walk_stride"], g["walk_frames"], g["walk_duty"], g["lift"]
    hop_flex = {"hind": dict(lean=12, push=30, fold=40, curl=20), "fore": dict(lean=10, push=20, fold=60, curl=25, scap=10)}

    def walk(t):
        ik, st = B.gait_targets(rest, t, S, duty, lift, HOP, hop_flex)
        # Airborne between the hind push-off and the forepaws landing.
        rise = 0.022 * max(0.0, math.sin(math.pi * ((t - duty * 0.85) % 1.0) / 0.55)) if ((t - duty * 0.85) % 1.0) < 0.55 else 0.0
        pitch = 7 * wave(t, 0.1)
        fk = {"pelvis": (pitch, 0, 0), "spine": (-6 * wave(t, 0.35), 0, 0), "chest": (-4 * wave(t, 0.35), 0, 0)}
        fk.update({k: v for k, v in st.items() if k.startswith("scapula")})
        fk["neck"] = (-pitch * 0.6, 0, 0)
        fk["head"] = (-pitch * 0.4, 0, 0)
        fk.update(ears(t, back=10 + 6 * wave(t, 0.3)))
        fk["tail1"] = (-10, 0, 0)
        return dict(fk=fk, loc=V((0, 0, rise)), ik=ik)
    tracks = clip.run("walk", N, walk, track=track_of())
    report["walk"] = B.foot_slip(tracks, S, N, duty, HOP)

    # -- run: the bound, stretched out in the air, ears laid back.
    S2, N2, duty2, lift2 = g["run_stride"], g["run_frames"], g["run_duty"], g["run_lift"]
    bound = {"hind.L": 0.0, "hind.R": 0.04, "fore.L": 0.46, "fore.R": 0.56}
    run_flex = {"hind": dict(lean=20, push=35, fold=50, curl=30), "fore": dict(lean=16, push=25, fold=80, curl=30, scap=20)}

    def run(t):
        ik, st = B.gait_targets(rest, t, S2, duty2, lift2, bound, run_flex)
        flight = max(0.0, math.sin(2 * math.pi * (t - 0.2)))
        fk = {"pelvis": (-10 * wave(t, 0.15), 0, 0), "spine": (12 * wave(t, 0.4), 0, 0), "chest": (8 * wave(t, 0.4), 0, 0)}
        fk.update({k: v for k, v in st.items() if k.startswith("scapula")})
        fk["neck"] = (-6, 0, 0)
        fk["head"] = (6 * wave(t, 0.6), 0, 0)
        fk.update(ears(t, back=55))
        fk["tail1"] = (-25, 0, 0)
        return dict(fk=fk, loc=V((0, 0, 0.045 * flight + 0.01)), ik=ik)
    tracks = clip.run("run", N2, run, track=track_of())
    report["run"] = B.foot_slip(tracks, S2, N2, duty2, bound)

    # -- nibble: head down to the grass, cropping fast, ears up and turning.
    def nibble(t):
        chew = wave(10 * t)
        fk = {"pelvis": (3, 0, 0), "chest": (6, 0, 0), "neck": (34, 4 * wave(t, 0.2), 0), "head": (24 + 2 * chew, 0, 0),
              "jaw": (-4 * max(0.0, chew), 0, 0)}
        fk.update(ears(t, l=-10 * bump(t, 0.25, 0.06), r=-10 * bump(t, 0.7, 0.06), back=-4))
        fk["tail1"] = (0, 0, 0)
        return dict(fk=fk, loc=V((0, 0, -0.008)), ik=flat)
    clip.run("nibble", 90, nibble, step=2)

    # -- groom: back on the haunches, the forepaws come up and wipe down the
    # face together, twice, then a lick at one paw.
    def groom(t):
        up = ease(t / 0.15) * (1 - ease((t - 0.85) / 0.15))
        wipe = (0.5 - 0.5 * math.cos(2 * math.pi * 3 * min(1.0, max(0.0, (t - 0.15) / 0.6)))) * up
        rot = mathutils.Quaternion(V((1, 0, 0)), math.radians(-28 * up))
        fk = {"chest": (-6 * up, 0, 0), "neck": (14 * up + 10 * wipe, 0, 0), "head": (18 * up + 8 * wipe, 0, 0),
              "jaw": (-3 * wipe, 0, 0)}
        for tg in (".L", ".R"):
            fk["upperarm" + tg] = (-70 * up, 0, 0)
            fk["forearm" + tg] = (-60 * up + 40 * wipe, 0, 0)
            fk["wrist" + tg] = (-30 * up, 0, 0)
            fk["ftoe" + tg] = (20 * up, 0, 0)
        fk.update(ears(t, back=20 * up + 15 * wipe))
        ik = {leg: flat[leg] for leg in rest if leg.startswith("hind")}
        if up < 0.02:
            ik = flat
        return dict(fk=fk, loc=V((0, 0.03 * up, 0.012 * up)), rot=rot, ik=ik)
    clip.run("groom", 105, groom)

    # -- situp: up on the hind legs, body near upright, forepaws held to the
    # chest, ears straight up, head turning one way and the other.
    def situp(t):
        up = ease(t / 0.18) * (1 - ease((t - 0.8) / 0.18))
        look = hold_steps(t, [(0.25, 28.0), (0.48, -24.0), (0.7, 0.0)], snap=0.05) * up
        rot = mathutils.Quaternion(V((1, 0, 0)), math.radians(-62 * up))
        fk = {"spine": (-6 * up, 0, 0), "chest": (-4 * up, 0, 0), "neck": (30 * up, look * 0.5, 0), "head": (28 * up, look * 0.5, 0)}
        for tg in (".L", ".R"):
            fk["upperarm" + tg] = (-35 * up, 0, 0)
            fk["forearm" + tg] = (-75 * up, 0, 0)
            fk["wrist" + tg] = (40 * up, 0, 0)
        fk.update(ears(t, back=-18 * up, l=-8 * bump(t, 0.35, 0.05), r=-8 * bump(t, 0.55, 0.05)))
        fk["tail1"] = (0, 0, 0)
        ik = {leg: flat[leg] for leg in rest if leg.startswith("hind")}
        if up < 0.02:
            ik = flat
        return dict(fk=fk, loc=V((0, 0.06 * up, 0.035 * up)), rot=rot, ik=ik)
    clip.run("situp", 120, situp)

    # -- attack: a quick lunge and a nip, forepaws thumping down.
    HIT = 0.45

    def attack(t):
        crouch = ease(t / 0.3) * (1 - ease((t - 0.32) / 0.08))
        lunge = ease((t - 0.32) / 0.12) * (1 - ease((t - 0.6) / 0.4))
        fk = {"pelvis": (-6 * lunge, 0, 0), "chest": (4 * crouch, 0, 0), "neck": (8 * crouch - 6 * lunge, 0, 0),
              "head": (6 * crouch, 0, 0), "jaw": (-14 * bump(t, 0.45, 0.04), 0, 0)}
        fk.update(ears(t, back=40 * max(crouch, lunge)))
        fk["tail1"] = (-20 * lunge, 0, 0)
        ik = {leg: B.planted(rest, leg) for leg in rest}
        return dict(fk=fk, loc=V((0, -0.06 * lunge + 0.01 * crouch, -0.012 * crouch + 0.01 * lunge)), ik=ik)
    clip.run("attack", 18, attack)

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.3)) if t < 0.3 else (1 - ease((t - 0.3) / 0.7)) * 0.8
        fk = {"chest": (-5 * k, 0, 4 * k), "neck": (-10 * k, 8 * k, 0), "head": (-8 * k, 6 * k, 0)}
        fk.update(ears(t, back=50 * k))
        return dict(fk=fk, loc=V((0, 0.02 * k, 0.02 * k)), ik=flat)
    clip.run("hit", 10, hit)

    # -- death: a kick, then over on its side, the hind legs stretched out.
    root_h = poser.rest["pelvis"].translation.z

    def death(t):
        roll = ease((t - 0.15) / 0.4)
        kick = math.sin(2 * math.pi * 3 * t) * (1 - ease(t / 0.5))
        rot = mathutils.Quaternion(V((0, 1, 0)), math.radians(85 * roll))
        fk = {"neck": (-10 * roll, -15 * roll, 0), "head": (-10 * roll, -10 * roll, 0)}
        for tg in (".L", ".R"):
            fk["thigh" + tg] = (-30 * roll + 15 * kick, 0, 0)
            fk["shin" + tg] = (-40 * roll, 0, 0)
            fk["hock" + tg] = (20 * roll, 0, 0)
            fk["upperarm" + tg] = (25 * roll, 0, 0)
            fk["forearm" + tg] = (-20 * roll, 0, 0)
        fk.update(ears(t, back=60 * roll))
        loc = V((0, 0, -(root_h - 0.05) * roll))
        return dict(fk=fk, loc=loc, rot=rot, ik=flat, limp=ease((t - 0.1) / 0.3))
    clip.run("death", 36, death)

    report["clips"] = clip.report
    report["stride"] = {"walk": S, "run": S2}
    report["overreach"] = clip.reach
    report["hit"] = HIT
    return report


# ============================================================ the snail


def snail():
    """'A snail is trying to get out of your way. You don't see much but slime
    about it.' An arena snail, then, big enough to be in anybody's way: half
    a metre of soft grey-brown foot, glistening, a coiled shell on its back
    banded in brown, and on its head two long stalks with the eyes at their
    tips and two short feelers below them that it keeps touching to the
    ground. Built gliding: the foot flat on the floor, the head up."""
    bones = [("body", P(0, -0.05, 0.035), P(0, 0.08, 0.038), None),
             ("front", P(0, 0.08, 0.038), P(0, 0.19, 0.045), "body"),
             ("head", P(0, 0.19, 0.045), P(0, 0.25, 0.06), "front"),
             ("rear", P(0, -0.05, 0.035), P(0, -0.16, 0.026), "body"),
             ("tail", P(0, -0.16, 0.026), P(0, -0.28, 0.012), "rear"),
             ("shell", P(0, -0.03, 0.07), P(0, -0.03, 0.2), "body")]
    stalk = [(0.017, 0.215, 0.07), (0.028, 0.24, 0.13), (0.036, 0.262, 0.19)]
    feeler = [(0.016, 0.24, 0.045), (0.03, 0.29, 0.03)]
    for side, tg in ((1, ".L"), (-1, ".R")):
        a = [B.apply_side(p, side) for p in stalk]
        f = [B.apply_side(p, side) for p in feeler]
        bones += [("stalk1" + tg, P(*a[0]), P(*a[1]), "head"), ("stalk2" + tg, P(*a[1]), P(*a[2]), "stalk1" + tg),
                  ("feeler" + tg, P(*f[0]), P(*f[1]), "head")]
    foot = [(0.25, 0.03, 0.05), (0.19, 0.045, 0.06), (0.08, 0.064, 0.05), (-0.05, 0.068, 0.045),
            (-0.16, 0.05, 0.032), (-0.28, 0.008, 0.012)]
    fbones = ["head", "front", "body", "rear", "tail"]
    body = []
    for i in range(len(foot) - 1):
        (f0, w0, h0), (f1, w1, h1) = foot[i], foot[i + 1]
        # Flat-soled and wider than it is deep: a squashed round cone sitting
        # on the floor.
        body.append(cone(P(0, f0, h0 * 0.55), P(0, f1, h1 * 0.55), w0, w1, fbones[i], blend=0.03, group="foot",
                         squash=(1.0, 1.0, max(h0, 0.01) / max(w0, 0.01) * 0.95)))
    # The head end lifted off the floor, rounded.
    body.append(ell(P(0, 0.215, 0.062), (0.04, 0.045, 0.035), "head", blend=0.025))
    # The mantle where the body goes up into the shell.
    body.append(ell(P(0, 0.0, 0.07), (0.06, 0.08, 0.04), ("grad", "body", "shell", P(0, 0, 0.05), P(0, 0, 0.1)), blend=0.03))

    def masks(co, n, pale, dark):
        u = co[:, 2]
        # The sole and the skirt of the foot paler; the back of the neck
        # darker, wrinkled into the patch noise.
        sole = np.clip((0.02 - u) / 0.02, 0, 1)
        back = np.clip((n[:, 2] - 0.5) / 0.4, 0, 1) * (u > 0.05)
        # The shell is the pale channel (see parts), so the sole only a little.
        return np.maximum(pale, sole * 0.25), np.maximum(dark, back * 0.4)

    def parts(body_solids):
        out = []
        # The shell: a logarithmic spiral of tube, coiled in the animal's own
        # side plane and drifting over to its right as it closes, from the
        # big body whorl over the mantle to the apex. Each step its own
        # cone, joined hard, so it reads as one coiled tube.
        c = V((0, -0.04, 0.165))
        R0, b = 0.098, 0.15
        pts = []
        th = 0.0
        while th < 3.4 * math.pi:
            R = R0 * math.exp(-b * th)
            # From the aperture at the front, low over the body, up and over
            # the top and down the back: the body whorl, then the spire.
            ang = -math.pi * 0.42 + th
            pts.append((V((-0.008 * th, c.y + R * math.cos(ang), c.z + R * math.sin(ang))), R * 0.64))
            th += 0.2
        shell = []
        for i in range(len(pts) - 1):
            (a, ra), (b_, rb) = pts[i], pts[i + 1]
            stripe = 0.75 if (i % 4) in (0, 1) else 0.0
            # Rounder than it is flat: a garden snail's whorls are wide.
            shell.append(cone(P(*a), P(*b_), ra, rb, "shell", blend=0.01, group="whorl", mask=(0.0, stripe),
                              squash=(1.4, 1.0, 1.0)))
        # The lip of the aperture, flaring a little over the body.
        shell.append(ell(P(*pts[0][0]), (pts[0][1] * 1.08, pts[0][1] * 0.35, pts[0][1] * 1.0), "shell", blend=0.01,
                         mask=(0.8, 0.0)))
        out.append(B.sdf_part(shell, 0.003, 2600, "shell", "chitin", smooth=1,
                              mask_fn=lambda co, n, p, d: (np.ones(len(co)), d), patch_fn=lambda co: np.zeros(len(co))))
        # Eye-stalks and feelers: soft tubes, a dark eye at the tip of each stalk.
        tubes = []
        for side, tg in ((1, ".L"), (-1, ".R")):
            a = [B.apply_side(p, side) for p in stalk]
            f = [B.apply_side(p, side) for p in feeler]
            tubes += [cone(P(*a[0]), P(*a[1]), 0.009, 0.0065, "stalk1" + tg, blend=0.004, group="s" + tg),
                      cone(P(*a[1]), P(*a[2]), 0.0065, 0.005, "stalk2" + tg, blend=0.004, group="s" + tg),
                      ell(P(*a[2]), (0.008, 0.008, 0.008), "stalk2" + tg, blend=0.003),
                      cone(P(*f[0]), P(*f[1]), 0.008, 0.005, "feeler" + tg, blend=0.004, group="f" + tg)]
        out.append(B.sdf_part(tubes, 0.0025, 900, "stalks", "ooze", smooth=1))
        eyes = []
        for side, tg in ((1, ".L"), (-1, ".R")):
            a = V(B.apply_side(stalk[2], side))
            eyes.append(ell(P(a.x, a.y + 0.004, a.z + 0.003), (0.0055, 0.0055, 0.0055), "stalk2" + tg, blend=0.0))
        out.append(B.solid_part(eyes, 0.0012, 120, "eye", "horn", (0.03, 0.025, 0.02), smooth=0))
        return out

    return dict(name="beast_snail", archetype="snail", body=body, masks=masks, parts=parts, bones=bones,
                patch=B.spots(0.02, seed=151), h=0.004, tris=2400, mat="ooze", clips=snail_clips, legtop=1.0,
                gait=dict(walk_stride=0.22, walk_frames=60, run_stride=0.3, run_frames=45))


def snail_clips(arm, spec):
    """A body with no feet: it glides. What can be seen of that is the foot's
    ripple, a slow wave running forward along its length, and the head and
    the stalks swaying as it goes; the stride is how far the skin carries it
    per cycle. Standing, it `feel`s about with its stalks and feelers, and
    now and then it `withdraw`s -- stalks rolled in, head under the shell --
    and comes out again."""
    g = spec["gait"]
    poser = B.Poser(arm, {})
    clip = B.Clip(poser)
    tgs = (".L", ".R")

    def pose(t, sway=0.0, nod=0.0, stalk=(0.0, 0.0), spread=(0.0, 0.0), feel=(0.0, 0.0), ripple=0.0, tuck=0.0, shell=0.0):
        fk = {"body": (0, 0, 0),
              "front": (ripple * wave(t, 0.0) + 14 * tuck, sway * 0.4, 0),
              "head": (nod + 30 * tuck, sway * 0.6, 0),
              "rear": (ripple * wave(t, 0.25), -sway * 0.3, 0),
              "tail": (ripple * wave(t, 0.5), -sway * 0.4, 0),
              "shell": (-shell, 0, shell * 0.3)}
        for i, tg in enumerate(tgs):
            fk["stalk1" + tg] = (stalk[i] + 95 * tuck, (spread[i]) * (1 if i == 0 else -1), 0)
            fk["stalk2" + tg] = (stalk[i] * 0.6 + 60 * tuck, 0, 0)
            fk["feeler" + tg] = (feel[i] + 40 * tuck, 0, 0)
        return fk

    def idle(t):
        fk = pose(t, sway=4 * wave(t, 0.1), nod=2 * wave(2 * t),
                  stalk=(8 * wave(t, 0.0), 8 * wave(t, 0.4)), spread=(6 * wave(2 * t), 6 * wave(2 * t, 0.3)),
                  feel=(10 * max(0.0, wave(2 * t)), 10 * max(0.0, wave(2 * t, 0.5))))
        return dict(fk=fk, loc=V((0, 0, 0)))
    clip.run("idle", 150, idle, step=2)

    def glide(t, run=False):
        k = 1.4 if run else 1.0
        fk = pose(t, sway=6 * wave(t) * k, nod=3 * wave(2 * t), stalk=(-10 + 6 * wave(t, 0.2), -10 + 6 * wave(t, 0.6)),
                  spread=(8, 8), feel=(12 * max(0.0, wave(2 * t)), 12 * max(0.0, wave(2 * t, 0.5))), ripple=2.5 * k,
                  shell=1.5 * wave(t, 0.3))
        return dict(fk=fk, loc=V((0, 0, 0.002 * wave(2 * t))))
    clip.run("walk", g["walk_frames"], glide, step=2)
    clip.run("run", g["run_frames"], lambda t: glide(t, True))

    # -- feel: the stalks reaching out and round, one and then the other, the
    # feelers dabbing the floor, the head lifting to look.
    def feel(t):
        fk = pose(t, sway=12 * wave(t, 0.1), nod=-8 - 6 * wave(t, 0.3),
                  stalk=(-20 * max(0.0, wave(t)), -20 * max(0.0, wave(t, 0.5))),
                  spread=(18 * wave(2 * t), 18 * wave(2 * t, 0.25)),
                  feel=(30 * bump(t, 0.2, 0.05) + 30 * bump(t, 0.6, 0.05), 30 * bump(t, 0.4, 0.05) + 30 * bump(t, 0.85, 0.05)))
        return dict(fk=fk, loc=V((0, 0, 0)))
    clip.run("feel", 180, feel, step=2)

    # -- withdraw: in, and a long wait, and out again.
    def withdraw(t):
        tuck = ease(t / 0.12) * (1 - ease((t - 0.6) / 0.35))
        fk = pose(t, tuck=tuck, shell=6 * tuck)
        return dict(fk=fk, loc=V((0, 0.03 * tuck, -0.01 * tuck)))
    clip.run("withdraw", 180, withdraw, step=2)

    # -- attack: the head rears and comes down on you, rasping.
    def attack(t):
        rear = ease(t / 0.35) * (1 - ease((t - 0.42) / 0.1))
        strike = ease((t - 0.4) / 0.1) * (1 - ease((t - 0.62) / 0.38))
        fk = pose(t, nod=-25 * rear + 25 * strike, stalk=(30 * rear, 30 * rear), feel=(-20 * rear, -20 * rear))
        fk["front"] = (-25 * rear + 18 * strike, 0, 0)
        return dict(fk=fk, loc=V((0, -0.04 * strike, 0.0)))
    clip.run("attack", 24, attack)

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.3)) if t < 0.3 else (1 - ease((t - 0.3) / 0.7)) * 0.8
        fk = pose(t, tuck=0.6 * k, shell=8 * k)
        return dict(fk=fk, loc=V((0, 0.01 * k, 0)))
    clip.run("hit", 12, hit)

    # -- death: in for good, and the shell rolls over onto its side.
    def death(t):
        tuck = ease(t / 0.3)
        fall = ease((t - 0.3) / 0.5)
        fk = pose(t, tuck=tuck, shell=10 * tuck)
        fk["front"] = (14 * tuck + 20 * fall, 0, 0)
        fk["tail"] = (0, 20 * fall, 0)
        rot = mathutils.Quaternion(V((0, 1, 0)), math.radians(-70 * fall))
        return dict(fk=fk, rot=rot, loc=V((0, 0, 0.02 * fall)))
    clip.run("death", 45, death)

    return {"clips": clip.report, "stride": {"walk": g["walk_stride"], "run": g["run_stride"]}, "hit": 0.5}


# ============================================================ the beast


def beast():
    """'A beast tries to feed off of you. It looks mean. You'd better run.'
    Something that feeds off you rather than eats you: a hairless, hunched
    hunter the size of a big hyena -- the shoulders high and the hindquarters
    low, gaunt legs on clawed feet, a thin bare tail, a ridge of spines down
    the back -- whose face ends in a round sucking disc ringed with teeth,
    like a lamprey's, under small burning eyes. The diploma beast ('hideous
    ... this horrible creature') is the same thing bigger, warted and horned;
    the horns are an optional part the viewer collapses on the plain one."""
    L = dict(
        spine=[(0, -0.4, 0.66), (0, -0.12, 0.75), (0, 0.2, 0.87), (0, 0.42, 0.88)],
        neck=[(0, 0.42, 0.84), (0, 0.63, 0.83)],
        nose=(0, 0.95, 0.7),
        tail=[(0, -0.45, 0.64), (0, -0.6, 0.6), (0, -0.75, 0.5), (0, -0.88, 0.38), (0, -0.97, 0.26)],
        hind=[(0.13, -0.34, 0.6), (0.15, -0.2, 0.38), (0.14, -0.38, 0.17),
              (0.13, -0.34, 0.05), (0.13, -0.25, 0.012)],
        fore=[(0.16, 0.38, 0.7), (0.15, 0.3, 0.42), (0.145, 0.36, 0.14),
              (0.14, 0.4, 0.05), (0.14, 0.51, 0.012)],
        scapula=(0.12, 0.26, 0.93),
        extra={"ear*": ((0.09, 0.66, 0.93), (0.15, 0.6, 1.02), "head"),
               "horn*": ((0.07, 0.72, 0.96), (0.15, 0.58, 1.14), "head")},
    )
    tail = L["tail"]
    body = [
        ell(P(0, 0.2, 0.68), (0.19, 0.3, 0.24), ("grad", "spine", "chest", P(0, 0.0, 0.7), P(0, 0.35, 0.7)), blend=0.07),
        # The hump of the shoulders, the hunter's build.
        ell(P(0, 0.28, 0.88), (0.15, 0.2, 0.1), "chest", blend=0.08),
        cone(P(0, 0.0, 0.66), P(0, -0.32, 0.62), 0.14, 0.15, ("grad", "spine", "pelvis", P(0, 0.0, 0.66), P(0, -0.32, 0.62)), blend=0.07),
        ell(P(0, -0.37, 0.62), (0.14, 0.13, 0.13), "pelvis", blend=0.06),
        cone(P(0, 0.38, 0.8), P(0, 0.66, 0.83), 0.16, 0.12, ("chain", [("chest", P(0, 0.36, 0.8)), ("neck", P(0, 0.5, 0.82)),
                                                                     ("head", P(0, 0.66, 0.83))]), blend=0.07),
        # A big blunt head, heavy at the jowls, narrowing to the disc.
        ell(P(0, 0.72, 0.84), (0.13, 0.14, 0.12), "head", blend=0.05),
        cone(P(0, 0.76, 0.82), P(0, 0.88, 0.72), 0.12, 0.1, "head", blend=0.05, squash=(1.0, 1.0, 0.95)),
        ell(P(0, 0.8, 0.76), (0.12, 0.1, 0.08), "head", blend=0.05),
        # The disc: a thick lip standing round a mouth that is all opening,
        # cut deep into the end of the face.
        ell(P(0, 0.915, 0.705), (0.112, 0.04, 0.112), "head", blend=0.03),
        ell(P(0, 0.95, 0.705), (0.082, 0.06, 0.082), "head", blend=0.015, neg=True),
        # Brows over the eyes.
        ell(P(0.07, 0.8, 0.9), (0.04, 0.06, 0.025), "head", blend=0.03),
        ell(P(-0.07, 0.8, 0.9), (0.04, 0.06, 0.025), "head", blend=0.03),
    ]
    for i in range(len(tail) - 1):
        body.append(cone(P(*tail[i]), P(*tail[i + 1]), 0.05 - i * 0.01, 0.042 - i * 0.01, "tail%d" % (i + 1),
                         blend=0.03, group="tail"))
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += B.leg_solids(L, "hind", [0.095, 0.055, 0.038, 0.034, 0.0], 0.05, side, mask_low=0.3)
        body += B.leg_solids(L, "fore", [0.09, 0.06, 0.04, 0.036, 0.0], 0.05, side, mask_low=0.3)
        body.append(ell(P(side * 0.14, -0.33, 0.5), (0.08, 0.13, 0.15), "thigh" + t, blend=0.06))
        body.append(ell(P(side * 0.16, 0.34, 0.6), (0.08, 0.1, 0.15), "upperarm" + t, blend=0.06))
        body.append(ell(P(side * 0.14, 0.36, 0.3), (0.05, 0.06, 0.11), "forearm" + t, blend=0.04))
        body.append(ell(P(side * 0.135, -0.29, 0.03), (0.045, 0.08, 0.03), "htoe" + t, blend=0.025))
        body.append(ell(P(side * 0.14, 0.46, 0.03), (0.05, 0.08, 0.03), "ftoe" + t, blend=0.025))

    def masks(co, n, pale, dark):
        u = co[:, 2]
        under = np.clip((-n[:, 2] - 0.15) / 0.5, 0, 1) * (u < 0.62)
        back = np.clip((n[:, 2] - 0.5) / 0.4, 0, 1) * (u > 0.7)
        return np.maximum(pale, under * 0.8), np.maximum(dark, back * 0.5)

    def parts(body_solids):
        out = []
        # The disc's throat, and three rings of hooked teeth pointing in.
        throat = [ell(P(0, 0.9, 0.705), (0.074, 0.02, 0.074), "head", blend=0.005)]
        out.append(B.solid_part(throat, 0.004, 160, "maw", "horn", (0.32, 0.06, 0.06)))
        teeth = []
        for ring, (rr, n, ln, f) in enumerate(((0.078, 18, 0.03, 0.935), (0.058, 14, 0.026, 0.92), (0.038, 9, 0.02, 0.908))):
            for k in range(n):
                a = 2 * math.pi * (k + 0.5 * ring) / n
                root = V((math.cos(a) * rr, f, 0.705 + math.sin(a) * rr))
                tip = V((math.cos(a) * (rr - ln * 0.8), f - 0.006, 0.705 + math.sin(a) * (rr - ln * 0.8)))
                teeth.append(cone(P(*root), P(*tip), 0.0065, 0.0012, "head", blend=0.001, group="t%d_%d" % (ring, k)))
        out.append(B.solid_part(teeth, 0.0018, 1600, "teeth", "horn", (0.78, 0.74, 0.6), smooth=0))
        # Small eyes deep under the brows, lit from inside.
        for side in (1, -1):
            at = B.surface_point(body_solids, P(side * 0.2, 0.84, 0.86), P(-side, -0.25, 0), sink=0.012)
            out.append(B.solid_part([ell(tuple(at), (0.016, 0.02, 0.012), "head", blend=0.003)], 0.003, 70,
                                    "eye", "glow", (1.0, 1.0, 1.0), smooth=0))
        out += B.leaf_pair(L, "ear", 0.04, 0.012, (1.0, 0.35, 1.0), 0.005, tris=120, mat="hide", mask=(0, 0.4))
        # Horns: swept back off the brow, ridged, for the diploma beast.
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            head, tail_, _ = L["extra"]["horn*"]
            a, b = V(B.apply_side(head, side)), V(B.apply_side(tail_, side))
            mid = a.lerp(b, 0.5) + V((side * 0.03, 0.03, 0.02))
            out.append(B.solid_part([cone(P(*a), P(*mid), 0.035, 0.024, "horn" + t, blend=0.006, group="h"),
                                     cone(P(*mid), P(*b), 0.024, 0.004, "horn" + t, blend=0.006, group="h")],
                                    0.004, 220, "horn", "horn", (0.3, 0.27, 0.22)))
        # The spines: a ridge of them down the back, longest at the hump.
        spines = []
        for i in range(16):
            f = 0.55 - i * 0.07
            top = B.surface_point(body_solids, P(0, f, 1.6), P(0, 0, -1), sink=0.03)
            bone = "chest" if f > 0.2 else "spine" if f > -0.15 else "pelvis" if f > -0.42 else "tail1"
            ln = 0.05 + 0.1 * math.exp(-((f - 0.28) / 0.3) ** 2)
            spines.append(cone(tuple(top), tuple(top + V((0, 0.03, ln))), 0.024, 0.003, bone, blend=0.004, group="s%d" % i))
        out.append(B.solid_part(spines, 0.004, 1000, "spines", "horn", (0.22, 0.2, 0.17), smooth=0))
        out += B.claws(L, "fore", 4, 0.07, 0.014, 0.004)
        out += B.claws(L, "hind", 4, 0.055, 0.012, 0.004)
        return out

    return dict(name="beast_beast", archetype="beast", L=L, body=body, masks=masks, parts=parts, mat="hide",
                patch=B.spots(0.06, seed=171), h=0.01, tris=3600,
                gait=dict(walk_stride=0.95, walk_frames=30, walk_duty=0.64, lift=0.08,
                          run_stride=1.8, run_frames=16, run_duty=0.36, run_lift=0.14,
                          gallop="rotary", wag=3.0, idle_wag=1, tail_pitch=-8.0, lie=0.26, arch=6.0,
                          pastimes=["sniff", "snarl"], sniff_face=55.0, sniff_ground=0.12, sniff_most=70.0,
                          flex={"hind": dict(lean=8, push=18, fold=34, curl=30),
                                "fore": dict(lean=8, push=20, fold=70, curl=30, scap=12)}))


# ============================================================ the blob


def blob():
    """'The blob is here, waiting to eat you up. He is big, he is bad.' A heap
    of glistening green jelly as high as a man's chest and wider than it is
    high, slumped on the floor in lobes, with a mouth that is only a fold
    in the front of it until it opens, and two thick pseudopods it reaches
    out with. Lumps of something it has not finished with show dark under
    its skin (the patch channel)."""
    rng = np.random.default_rng(181)
    bones = [("base", P(0, -0.1, 0.05), P(0, 0.25, 0.05), None),
             ("mid", P(0, 0.0, 0.1), P(0, 0.02, 0.6), "base"),
             ("top", P(0, 0.02, 0.6), P(0, 0.06, 1.05), "mid"),
             ("lip", P(0, 0.42, 0.4), P(0, 0.62, 0.32), "mid")]
    pod = [(0.5, 0.15, 0.45), (0.78, 0.35, 0.3), (0.92, 0.6, 0.12)]
    for side, tg in ((1, ".L"), (-1, ".R")):
        q = [B.apply_side(p, side) for p in pod]
        bones += [("pod1" + tg, P(*q[0]), P(*q[1]), "mid"), ("pod2" + tg, P(*q[1]), P(*q[2]), "pod1" + tg)]
    grad = lambda b0, b1, z0, z1: ("grad", b0, b1, P(0, 0, z0), P(0, 0, z1))
    body = [
        # The heap: a broad slumped base, a mass on it, a crown.
        ell(P(0, 0.0, 0.16), (0.82, 0.78, 0.2), "base", blend=0.2),
        ell(P(0, 0.02, 0.45), (0.62, 0.58, 0.4), grad("base", "mid", 0.15, 0.6), blend=0.25),
        ell(P(0, 0.04, 0.82), (0.4, 0.38, 0.3), grad("mid", "top", 0.6, 1.0), blend=0.22),
        # The fold of the mouth, a lower lip hanging over it.
        ell(P(0, 0.6, 0.44), (0.4, 0.3, 0.085), "mid", blend=0.05, neg=True),
        ell(P(0, 0.56, 0.31), (0.34, 0.13, 0.08), "lip", blend=0.08),
    ]
    for side, tg in ((1, ".L"), (-1, ".R")):
        q = [B.apply_side(p, side) for p in pod]
        body += [cone(P(*q[0]), P(*q[1]), 0.2, 0.15, "pod1" + tg, blend=0.15, group="pod" + tg),
                 cone(P(*q[1]), P(*q[2]), 0.15, 0.1, "pod2" + tg, blend=0.15, group="pod" + tg)]
    # Lobes slumping down its sides.
    for i in range(18):
        ang = rng.uniform(0, 2 * math.pi)
        z = rng.uniform(0.15, 0.85)
        rr = (0.7 if z < 0.4 else 0.5) * rng.uniform(0.85, 1.0)
        c = (math.cos(ang) * rr, 0.02 + math.sin(ang) * rr * 0.9, z)
        r = rng.uniform(0.14, 0.24)
        body.append(ell(P(*c), (r, r, r * 0.75), "base" if z < 0.3 else "mid" if z < 0.65 else "top", blend=0.14))

    def masks(co, n, pale, dark):
        u = co[:, 2]
        # Paler where it is thin and the light comes through at the top;
        # darker low down where it gathers and drags.
        top = np.clip((u - 0.7) / 0.4, 0, 1) * np.clip(n[:, 2], 0, 1)
        low = np.clip((0.25 - u) / 0.25, 0, 1)
        return np.maximum(pale, top * 0.7), np.maximum(dark, low * 0.5)

    def parts(body_solids):
        out = []
        maw = [ell(P(0, 0.48, 0.43), (0.37, 0.16, 0.085), {"mid": 0.6, "lip": 0.4}, blend=0.02)]
        out.append(B.solid_part(maw, 0.01, 200, "maw", "horn", (0.18, 0.05, 0.05)))
        return out

    return dict(name="beast_blob", archetype="blob", body=body, masks=masks, parts=parts, bones=bones,
                patch=B.spots(0.16, seed=183), h=0.02, tris=3000, mat="ooze", clips=jelly_clips, legtop=9.0,
                gait=dict(walk_stride=0.55, walk_frames=48, run_stride=0.8, run_frames=36))


def jelly_clips(arm, spec):
    """A body of jelly: it wobbles. Standing, it heaves and sways and its
    pseudopods feel about; going, it lurches -- the top of the heap leans out
    ahead and the rest flows after it -- one surge a cycle, the stride being
    how far each surge carries it. It eats by rearing back, gaping, and
    falling forward over what it wants; it dies by slumping into a puddle."""
    g = spec["gait"]
    poser = B.Poser(arm, {})
    clip = B.Clip(poser)
    tgs = ((".L", 1), (".R", -1))

    def pose(lean=0.0, sway=0.0, top=0.0, gape=0.0, reach=(0.0, 0.0), curl=(0.0, 0.0), spread=0.0):
        fk = {"base": (0, 0, 0), "mid": (lean, 0, sway), "top": (top + lean * 0.6, 0, sway * 1.4),
              "lip": (gape, 0, 0)}
        for i, (tg, s_) in enumerate(tgs):
            fk["pod1" + tg] = (-reach[i], 0, s_ * spread)
            fk["pod2" + tg] = (-reach[i] * 0.5 + curl[i], 0, 0)
        return fk

    def idle(t):
        heave = wave(2 * t)
        fk = pose(lean=2 * heave, sway=3 * wave(t, 0.1) + 1.5 * wave(3 * t), top=-3 * heave + 2 * wave(5 * t),
                  gape=4 * max(0.0, wave(t, 0.6)),
                  reach=(10 * wave(t, 0.2), 10 * wave(t, 0.7)), curl=(15 * wave(2 * t), 15 * wave(2 * t, 0.4)))
        return dict(fk=fk, loc=V((0.01 * wave(t, 0.3), 0, 0.012 * heave)))
    clip.run("idle", 120, idle, step=2)

    def surge(t, k=1.0):
        lurch = 0.5 - 0.5 * math.cos(2 * math.pi * t)
        fk = pose(lean=(10 * lurch + 4) * k, sway=5 * wave(t, 0.1) * k, top=8 * wave(t, 0.15) * k, gape=3 * lurch,
                  reach=(20 * lurch * k, 20 * lurch * k), curl=(-10 * lurch, -10 * lurch), spread=6 * lurch)
        loc = V((0, -0.05 * wave(t, 0.1) * k, -0.03 * lurch))
        return dict(fk=fk, loc=loc)
    clip.run("walk", g["walk_frames"], surge, step=2)
    clip.run("run", g["run_frames"], lambda t: surge(t, 1.4))

    def attack(t):
        back = ease(t / 0.35) * (1 - ease((t - 0.4) / 0.08))
        fall = ease((t - 0.38) / 0.12) * (1 - ease((t - 0.62) / 0.38))
        gape = ease((t - 0.15) / 0.2) * (1 - ease((t - 0.5) / 0.08))
        fk = pose(lean=-14 * back + 28 * fall, top=-12 * back + 15 * fall, gape=40 * gape,
                  reach=(45 * back - 10 * fall, 45 * back - 10 * fall), spread=15 * back)
        return dict(fk=fk, loc=V((0, -0.35 * fall, 0.08 * back - 0.08 * fall)))
    clip.run("attack", 30, attack)

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.25)) if t < 0.25 else (1 - ease((t - 0.25) / 0.75)) * 0.8
        j = math.sin(2 * math.pi * 5 * t) * k
        fk = pose(lean=-10 * k, sway=8 * j, top=-10 * j, gape=10 * k)
        return dict(fk=fk, loc=V((0, 0.12 * k, -0.04 * k)))
    clip.run("hit", 16, hit)

    def death(t):
        k = ease(t / 0.85)
        fk = pose(lean=25 * k, top=35 * k, gape=20 * ease(t / 0.3), reach=(-30 * k, -30 * k), spread=30 * k)
        return dict(fk=fk, loc=V((0, 0.1 * k, -0.62 * k)))
    clip.run("death", 54, death)

    # -- quiver: a shudder that runs through it, the pseudopods drawn in.
    def quiver(t):
        k = ease(t / 0.15) * (1 - ease((t - 0.7) / 0.3))
        j = math.sin(2 * math.pi * 9 * t)
        fk = pose(sway=5 * j * k, top=-6 * j * k, gape=6 * k, reach=(-25 * k, -25 * k), curl=(30 * k, 30 * k))
        return dict(fk=fk, loc=V((0.012 * j * k, 0, 0.01 * k)))
    clip.run("quiver", 60, quiver)

    return {"clips": clip.report, "stride": {"walk": g["walk_stride"], "run": g["run_stride"]}, "hit": 0.5}


# ============================================================ library

SPECS = [lizard, rabbit, snail, beast, blob]


def build_one(spec, export=True):
    """Quadrupeds on beasts.py's skeleton (landmarks `L`), everything else on
    monsters.py's, which takes a bone table with rolls."""
    if "L" in spec and "bones" not in spec:
        return B.build_one(spec, export=export)
    return M.build_one(spec, export=export)


def build(only=None):
    lines = []
    for make in SPECS:
        spec = make()
        if only and spec["name"] not in only:
            continue
        arm, meshes, tris, rep = build_one(spec)
        clips = " ".join("%s %.2fs" % (k, v) for k, v in rep["clips"].items())
        stride = " ".join("%s %.2fm" % (k, v) for k, v in rep["stride"].items())
        slip = " ".join("%s-slip %.1fmm" % (k, rep[k] * 1000) for k in ("walk", "run") if k in rep)
        reach = " ".join("%s:%s" % (k, v[0]) for k, v in rep.get("overreach", {}).items() if v and v[0] > 0.001)
        lines.append("%-16s %5d tris  stride %s  %s  hit %.2f  | %s%s" % (
            spec["name"], tris, stride, slip, rep["hit"], clips, ("  overreach " + reach) if reach else ""))
    return "\n".join(lines)


def preview(make, path, clip=None, frame=0, azim=90.0, elev=8.0, dist=None, coat=(0.3, 0.28, 0.16),
            pale=(0.62, 0.58, 0.42), dark=(0.08, 0.08, 0.05), patch=None, built=None, target=None):
    """Render one creature (optionally at a frame of a clip) for judging by eye."""
    return M.preview(make, path, target=target, dist=dist, azim=azim, elev=elev, clip=clip, frame=frame,
                     coat=coat, pale=pale, dark=dark, patch=patch, built=built)
