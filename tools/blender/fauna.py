"""fauna -- animals that were being drawn as a townsperson in a tunic.

The frogs of the Wyvern's Tower ('a killer frog rises up out of the water')
and the Rock Toad of Mahn-Tor ('a rather large rock toad sits here, croaking
loudly ... about the size of a cow. Small horns grow all over its body').
Built the way beasts.py builds a dog -- blended solids sampled into one skin,
weighted from the same solids, masks in the vertex colours -- on beasts.py's
quadruped skeleton, so the viewer's breeds (scale, coat, spots) work as for
any other animal.

Blender is Z-up; every animal faces -Y with its left side +X, the ground at
z = 0, and specs are written in (side, forward, up) like beasts.py's.
"""

import math
import importlib

import bpy
import mathutils
import numpy as np

import lib
import beasts as B
import creatures as C

importlib.reload(lib)
importlib.reload(B)
importlib.reload(C)

V = mathutils.Vector
P = B.P
cone, ell = B.cone, B.ell
ease, lerp, wave = B.ease, B.lerp, B.wave
bump, hold_steps = C.bump, C.hold_steps
FPS = B.FPS


# ============================================================ the frog


def frog():
    """A bullfrog, 0.3 m from nose to rump as it sits: a squat, broad body
    tipped up at the front on short forelegs, a wide flat head that is
    mostly mouth, eyes standing up out of the top of it, a pale throat that
    swells when it calls, and hind legs folded in a Z against its sides --
    thigh forward, shin back, a long foot flat on the ground forward again.
    It moves in hops. The killer frog and the cow-sized Rock Toad are this,
    scaled and coated."""
    L = dict(
        spine=[(0, -0.075, 0.05), (0, -0.02, 0.07), (0, 0.04, 0.086), (0, 0.075, 0.094)],
        neck=[(0, 0.075, 0.094), (0, 0.09, 0.1)],
        nose=(0, 0.165, 0.082),
        jaw=[(0, 0.092, 0.078), (0, 0.158, 0.066)],
        # No tail on a frog: a stub of a bone, inside the rump.
        tail=[(0, -0.07, 0.052), (0, -0.08, 0.052)],
        hind=[(0.032, -0.062, 0.048), (0.085, -0.005, 0.032), (0.062, -0.095, 0.02),
              (0.06, -0.012, 0.006), (0.062, 0.045, 0.003)],
        fore=[(0.03, 0.055, 0.07), (0.044, 0.06, 0.04), (0.04, 0.08, 0.012),
              (0.04, 0.086, 0.004), (0.045, 0.102, 0.002)],
        extra={"throat": ((0, 0.1, 0.06), (0, 0.13, 0.055), "jaw"),
               "tongue": ((0, 0.1, 0.074), (0, 0.14, 0.068), "jaw")},
    )
    body = [
        # The trunk: wide, flat-bottomed, tipped up at the front.
        ell(P(0, -0.005, 0.066), (0.062, 0.085, 0.042), ("grad", "pelvis", "chest", P(0, -0.06, 0.06), P(0, 0.05, 0.08)), blend=0.025),
        ell(P(0, -0.05, 0.055), (0.05, 0.045, 0.034), "pelvis", blend=0.025),
        ell(P(0, 0.05, 0.08), (0.055, 0.04, 0.036), "chest", blend=0.022),
        # The head: as wide as the body, flat on top, a blunt rounded snout.
        ell(P(0, 0.11, 0.09), (0.056, 0.05, 0.026), "head", blend=0.02),
        ell(P(0, 0.14, 0.084), (0.04, 0.03, 0.018), "head", blend=0.016),
        # The eyes stand up out of the skull in their own turrets.
        ell(P(0.028, 0.112, 0.108), (0.016, 0.017, 0.015), "head", blend=0.008),
        ell(P(-0.028, 0.112, 0.108), (0.016, 0.017, 0.015), "head", blend=0.008),
        # Eardrums: the disc behind each eye.
        ell(P(0.05, 0.09, 0.094), (0.006, 0.012, 0.012), "head", blend=0.006, mask=(0, 0.5)),
        ell(P(-0.05, 0.09, 0.094), (0.006, 0.012, 0.012), "head", blend=0.006, mask=(0, 0.5)),
        # The throat, on a bone of its own so a call can swell it.
        ell(P(0, 0.112, 0.062), (0.036, 0.034, 0.014), {"throat": 0.8, "jaw": 0.2}, blend=0.014, mask=(1.0, 0)),
    ]
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += B.leg_solids(L, "hind", [0.024, 0.017, 0.011, 0.008, 0.005], 0.012, side)
        body += B.leg_solids(L, "fore", [0.012, 0.009, 0.007, 0.006, 0.004], 0.008, side)
        # The great thigh and the calf folded against it.
        body.append(ell(P(side * 0.06, -0.035, 0.044), (0.018, 0.04, 0.018), "thigh" + t, blend=0.01))
        body.append(ell(P(side * 0.072, -0.05, 0.03), (0.012, 0.038, 0.012), "shin" + t, blend=0.008))
        # Webbed hind foot: a fan on the ground.
        body.append(ell(P(side * 0.063, 0.024, 0.004), (0.015, 0.024, 0.003), "htoe" + t, blend=0.008, mask=(0.3, 0.2)))
        body.append(ell(P(side * 0.043, 0.094, 0.003), (0.01, 0.012, 0.003), "ftoe" + t, blend=0.005, mask=(0.3, 0)))

    def masks(co, n, pale, dark):
        u = co[:, 2]
        f = -co[:, 1]
        under = np.clip((-n[:, 2] - 0.2) / 0.5, 0, 1) * (u < 0.07)
        throat = np.clip((-n[:, 2] + 0.2) / 0.5, 0, 1) * (f > 0.09) * (u < 0.075)
        # A dark stripe from the eye back over the eardrum.
        mask = np.clip(1 - np.abs(u - 0.098) / 0.006, 0, 1) * (f > 0.07) * (f < 0.12) * (np.abs(co[:, 0]) > 0.035)
        return np.maximum(pale, np.maximum(under, throat)), np.maximum(dark, mask * 0.7)

    def parts(body_solids):
        out = []
        # Eyes: gold with a black pupil reading as one dark bead, on top.
        out += B.eye_pair(body_solids, (0.05, 0.115, 0.112), (-1.0, 0.0, -0.15), 0.0105, colour=(0.38, 0.28, 0.04),
                          sink=0.004, h=0.0012, tris=90)
        # The mouth line all the way round the snout, dark.
        lip = [ell(P(0, 0.12, 0.076), (0.05, 0.045, 0.004), {"head": 0.5, "jaw": 0.5}, blend=0.003)]
        out.append(B.solid_part(lip, 0.0012, 160, "mouth", "horn", (0.32, 0.12, 0.1)))
        # Nostrils.
        nos = []
        for s in (1, -1):
            at = B.surface_point(body_solids, P(s * 0.01, 0.2, 0.092), P(0, -1, -0.2), sink=0.0015)
            nos.append(ell(tuple(at), (0.0025, 0.0025, 0.002), "head", blend=0.0))
        out.append(B.solid_part(nos, 0.0008, 40, "nostril", "horn", (0.03, 0.025, 0.02), smooth=0))
        # The tongue: pink, folded in the floor of the mouth, flung out on its
        # bone when it catches something.
        tg = [cone(P(0, 0.1, 0.073), P(0, 0.14, 0.069), 0.008, 0.007, "tongue", blend=0.003),
              ell(P(0, 0.142, 0.069), (0.009, 0.007, 0.004), "tongue", blend=0.002)]
        out.append(B.solid_part(tg, 0.0012, 120, "tongue", "horn", (0.62, 0.3, 0.3)))
        return out

    return dict(name="beast_frog", archetype="anuran", L=L, body=body, masks=masks, parts=parts,
                patch=B.spots(0.018, seed=151), h=0.0022, tris=2800, mat="hide", clips=frog_clips,
                gait=dict(walk_stride=0.22, walk_frames=18, run_stride=0.42, run_frames=16))


def frog_clips(arm, spec):
    """A frog's day: sitting, the throat going in and out with its breath;
    `croak`, the throat blown out round and the body pumping with each call
    (the Rock Toad 'croaking loudly'); `snap`, the mouth flung open and the
    tongue out at something going past and back in; `bask`, flattened out
    with the legs drawn in and the eyes half sunk. It goes in hops: both hind
    feet push together, the body flies forward with the legs trailing out
    straight behind, and it lands on its forefeet with the hind feet folding
    back in under it. The stride is how far one hop carries it."""
    g = spec["gait"]
    poser = B.Poser(arm, B.quad_legs())
    rest = B.leg_rest(poser)
    clip = B.Clip(poser)
    report = {}
    flat = {leg: B.planted(rest, leg) for leg in rest}
    root_h = poser.rest["pelvis"].translation.z

    # The throat and the tongue move on location keys, which every clip has
    # to set, or one clip's swollen throat is the next one's resting throat.
    locs = {}

    def keyed(name, frames, fn, step=1, track=None):
        out = clip.run(name, frames, lambda t: fn(t), track=track, step=step)
        C.key_locations(arm, frames, lambda t: locs.get(name, lambda t: {"throat": V((0, 0, 0)), "tongue": V((0, 0, 0))})(t), step=step)
        return out

    def throat(k, tongue=0.0):
        # Down and forward: the skin hung on the throat bone balloons out.
        return {"throat": V((0, 0.012 * k, -0.02 * k)), "tongue": V((0, 0.05 * tongue, 0))}

    def idle(t):
        breath = 0.5 + 0.5 * wave(6 * t)
        look = hold_steps(t, [(0.15, 10.0), (0.55, -8.0), (0.85, 0.0)], snap=0.05)
        fk = {"chest": (0.4 * breath, 0, 0), "neck": (0, look * 0.4, 0), "head": (0, look * 0.6, 0)}
        return dict(fk=fk, loc=V((0, 0, 0.0008 * breath)), ik=flat)
    locs["idle"] = lambda t: throat(0.25 * (0.5 + 0.5 * wave(6 * t)))
    keyed("idle", 120, idle, step=2)

    # -- walk: one hop per cycle. Down on the haunches, the push (hind feet
    # on the ground behind the body as it goes), flight with the hind legs
    # straight out behind, and the landing on the forefeet with the hind
    # feet coming back in under it.
    def hop(t, S, H):
        # The viewer carries the figure forward at an even S per cycle; the
        # frog really sits still and then flies. So the body is offset in the
        # clip by where it really is less where the viewer has it -- behind
        # while it sits, catching up in the air -- and the feet on the ground
        # are held where they landed, which in the clip's frame is sliding
        # back at exactly S per cycle: no slip.
        ground = 0.42
        if t < ground:
            x = t / ground
            body = -S * t
            crouch = math.sin(math.pi * x)
            push = ease((x - 0.6) / 0.4)
            ik = {leg: B.planted(rest, leg, fwd=body) for leg in rest}
            for leg in ("hind.L", "hind.R"):
                ik[leg] = B.planted(rest, leg, fwd=body, meta=-50 * push, toe=20 * push)
            fk = {"pelvis": (-8 * push, 0, 0), "chest": (4 * crouch, 0, 0)}
            return dict(fk=fk, loc=V((0, -body, -root_h * 0.12 * crouch + root_h * 0.1 * push)), ik=ik)
        x = (t - ground) / (1 - ground)
        body = S * ease(x) - S * t
        arc = 4 * x * (1 - x)
        stretch = math.sin(math.pi * min(1.0, x * 1.4))
        ik = {}
        for leg in rest:
            if leg.startswith("hind"):
                # Kicked out straight behind in the air.
                ik[leg] = B.planted(rest, leg, fwd=body - 0.14 * stretch, up=H * arc + 0.03 * stretch,
                                    meta=-85 * stretch, toe=60 * stretch)
            else:
                ik[leg] = B.planted(rest, leg, fwd=body + S * 0.06 * stretch, up=H * arc, meta=-20 * stretch)
        fk = {"pelvis": (-12 * stretch, 0, 0), "chest": (6 * stretch, 0, 0), "head": (-6 * stretch, 0, 0)}
        return dict(fk=fk, loc=V((0, -body, H * arc + root_h * 0.1 * (1 - ease(x / 0.3)))), ik=ik)

    S, N = g["walk_stride"], g["walk_frames"]
    keyed("walk", N, lambda t: hop(t, S, S * 0.45))
    S2, N2 = g["run_stride"], g["run_frames"]
    keyed("run", N2, lambda t: hop(t, S2, S2 * 0.5))

    def croak(t):
        # Three calls: the throat blows out round, the body pumps.
        call = max(bump(t, c, 0.06) for c in (0.25, 0.48, 0.71)) * ease(t / 0.1) * (1 - ease((t - 0.9) / 0.1))
        fk = {"chest": (-2 * call, 0, 0), "head": (-3 * call, 0, 0)}
        return dict(fk=fk, loc=V((0, 0, 0.004 * call)), ik=flat)
    locs["croak"] = lambda t: throat(max(bump(t, c, 0.06) for c in (0.25, 0.48, 0.71)) * ease(t / 0.1) * (1 - ease((t - 0.9) / 0.1)) * 1.4)
    keyed("croak", 90, croak)

    def snap(t):
        # A look, a lunge of the head, the mouth open and the tongue out at
        # its full length and back, a swallow (the eyes pressed down).
        aim = ease(t / 0.25) * (1 - ease((t - 0.75) / 0.25))
        flick = bump(t, 0.42, 0.05)
        gulp = bump(t, 0.62, 0.05)
        fk = {"chest": (-6 * aim, 0, 0), "neck": (-4 * aim, 8 * aim, 0), "head": (-6 * aim, 10 * aim, 0),
              "jaw": (min(1.0, flick * 1.5) * 30, 0, 0)}
        return dict(fk=fk, loc=V((0, -0.01 * flick, 0.006 * aim - 0.004 * gulp)), ik=flat)
    locs["snap"] = lambda t: throat(bump(t, 0.62, 0.05) * 0.6, bump(t, 0.42, 0.04))
    keyed("snap", 60, snap)

    def bask(t):
        breath = 0.5 + 0.5 * wave(3 * t)
        fk = {"chest": (6 + 0.4 * breath, 0, 0), "head": (6, 0, 0)}
        ik = {leg: B.planted(rest, leg, meta=10 if leg.startswith("hind") else 25) for leg in rest}
        return dict(fk=fk, loc=V((0, 0, -root_h * 0.3)), ik=ik)
    locs["bask"] = lambda t: throat(0.15 * (0.5 + 0.5 * wave(3 * t)))
    keyed("bask", 120, bask, step=2)

    HIT = 0.5

    def attack(t):
        crouch = ease(t / 0.35) * (1 - ease((t - 0.4) / 0.1))
        lunge = ease((t - 0.4) / 0.12) * (1 - ease((t - 0.65) / 0.35))
        fk = {"pelvis": (-10 * lunge, 0, 0), "chest": (6 * crouch - 6 * lunge, 0, 0),
              "head": (4 * crouch - 6 * lunge, 0, 0), "jaw": (40 * bump(t, 0.5, 0.06), 0, 0)}
        ik = dict(flat)
        return dict(fk=fk, loc=V((0, -0.06 * lunge, -0.012 * crouch + 0.02 * lunge)), ik=ik)
    locs["attack"] = lambda t: throat(0.0, bump(t, 0.5, 0.05))
    keyed("attack", 21, attack)

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.3)) if t < 0.3 else (1 - ease((t - 0.3) / 0.7)) * 0.8
        fk = {"chest": (-6 * k, 0, 5 * k), "head": (-8 * k, 6 * k, 0)}
        return dict(fk=fk, loc=V((0, 0.02 * k, 0.02 * k)), ik=flat)
    keyed("hit", 11, hit)

    def death(t):
        roll = ease((t - 0.15) / 0.4)
        kick = math.sin(2 * math.pi * 3 * t) * (1 - ease(t / 0.5))
        rot = mathutils.Quaternion(V((0, 1, 0)), math.radians(170 * roll))
        fk = {"head": (-10 * roll, 0, 0)}
        for tg in (".L", ".R"):
            fk["thigh" + tg] = (-40 * roll + 20 * kick, 0, 0)
            fk["shin" + tg] = (60 * roll, 0, 0)
            fk["upperarm" + tg] = (30 * roll, 0, 0)
        return dict(fk=fk, loc=V((0, 0, 0.035 * roll)), rot=rot, ik=flat, limp=ease((t - 0.1) / 0.3))
    keyed("death", 36, death)

    report["clips"] = clip.report
    report["stride"] = {"walk": S, "run": S2}
    report["overreach"] = clip.reach
    report["hit"] = HIT
    report["walk"] = 0.0
    return report


# ============================================================ library

SPECS = [frog]


def build_one(spec, export=True):
    return B.build_one(spec, export=export)


def build(only=None):
    lines = []
    for make in SPECS:
        spec = make()
        if only and spec["name"] not in only:
            continue
        arm, meshes, tris, rep = build_one(spec)
        clips = " ".join("%s %.2fs" % (k, v) for k, v in rep["clips"].items())
        stride = " ".join("%s %.2fm" % (k, v) for k, v in rep["stride"].items())
        reach = " ".join("%s:%s" % (k, v[0]) for k, v in rep.get("overreach", {}).items() if v and v[0] > 0.001)
        lines.append("%-16s %5d tris  stride %s  hit %.2f  | %s%s" % (
            spec["name"], tris, stride, rep["hit"], clips, ("  overreach " + reach) if reach else ""))
    return "\n".join(lines)
