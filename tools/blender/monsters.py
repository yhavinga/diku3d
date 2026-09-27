"""monsters -- the creatures of the sewer, the desert and the marsh that are not
animals anyone keeps: spiders, beetles, a scorpion, a bat, a mud thing, a
naga, an eight-legged basilisk, a dracolich, a sand worm, a drider, walking
fungus, a dustdigger, a camel, the rat-men and the winged imps.

Built exactly the way beasts.py builds a dog -- blended solids sampled into one
skin, weighted from the same solids, masks in the vertex colours for the
viewer to paint -- and it borrows beasts.py's machinery wholesale. What is new
here is what those bodies need that a mammal does not:

- Legs that splay sideways. A quadruped's leg swings in the fore-aft plane,
  so every bone keeps local X on world X. A spider's leg lives in a vertical
  plane through its hip that turns as the leg swings; its bones are rolled so
  local X is that plane's normal, and the IK builds its frames the same way,
  so a leg never twists about itself as it walks (`ArthroPoser`).
- Gaits for six and eight legs: an alternating tripod for the beetle, an
  alternating tetrapod with a metachronal lag for the spiders.
- Bodies with no feet at all -- a mud mass that rolls forward on its own
  base, a worm that swims up out of the sand -- whose stride is the distance
  the skin travels over the ground per cycle, and so is still exact.

Blender is Z-up; every creature faces -Y with its left side +X, like beasts.
"""

import json
import math
import importlib

import bpy
import mathutils
import numpy as np

import lib
import beasts as B

importlib.reload(lib)
importlib.reload(B)

V = mathutils.Vector
P = B.P
cone, ell = B.cone, B.ell
ease, lerp, wave = B.ease, B.lerp, B.wave
FPS = B.FPS


# ============================================================ rig with rolls


def make_rig(name, bones):
    """Like beasts.make_rig, but a bone may name the world direction its local X
    should take: (name, head, tail, parent[, xaxis]). Without one it gets the
    beasts convention -- local X on world X, which makes pitch a pitch."""
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    arm = bpy.context.object
    arm.name = name + "_rig"
    arm.data.name = name + "_rig"
    eb = arm.data.edit_bones
    for b in list(eb):
        eb.remove(b)
    xaxes = {}
    for entry in bones:
        bname, head, tail, parent = entry[:4]
        bone = eb.new(bname)
        bone.head, bone.tail = V(head), V(tail)
        if parent:
            bone.parent = eb[parent]
            bone.use_connect = (V(eb[parent].tail) - V(head)).length < 1e-6
        bone.use_deform = True
        if len(entry) > 4 and entry[4] is not None:
            xaxes[bname] = V(entry[4])
    for bone in eb:
        y = (bone.tail - bone.head).normalized()
        want = xaxes.get(bone.name)
        if want is None:
            if abs(y.x) > 0.7:
                bone.align_roll(V((0.0, 0.0, 1.0)))
                continue
            want = V((1.0, 0.0, 0.0))
        x = want - y * want.dot(y)
        if x.length < 1e-5:
            x = V((0.0, 0.0, 1.0)).cross(y)
        x.normalize()
        # align_roll aims the bone's Z; Z = X x Y puts X where it was wanted.
        bone.align_roll(x.cross(y))
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def build_body(spec):
    body = B.sdf_part(spec["body"], spec["h"], spec["tris"], "body", spec.get("mat", "fur"),
                      smooth=spec.get("smooth", 2), mask_fn=spec.get("masks"), patch_fn=spec.get("patch"))
    parts = [body] + spec["parts"](spec["body"])
    arm = make_rig(spec["name"], spec["bones"])
    meshes = B.bind(arm, parts, spec["name"])
    return arm, meshes, lib.stats(meshes)


def build_one(spec, export=True):
    lib.reset()
    bpy.context.scene.render.fps = FPS
    arm, meshes, tris = build_body(spec)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    report = spec["clips"](arm, spec)
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.animation_data.action = bpy.data.actions["idle"]
    arm["diku"] = json.dumps({
        "archetype": spec["archetype"],
        "stride": {k: round(v, 4) for k, v in report["stride"].items()},
        "hitFrame": {"attack": report["hit"]},
        "clips": {k: round(v, 4) for k, v in report["clips"].items()},
        **spec.get("extras", {}),
    })
    if export:
        B.export_beast(spec["name"], arm, meshes)
    return arm, meshes, tris, report


def keyed(poser, arm, name, frames, fn, step=1, report=None):
    """Key a clip from fn(t) -> {bone: (quat, loc|None)} computed directly,
    for the bodies that are not posed through Poser.solve (the blob, the worm,
    the dustdigger): quaternions kept on one hemisphere, keys linear."""
    act = B.new_action(arm, name, frames)
    last = {}
    for i in list(range(0, frames, step)) + [frames]:
        basis = fn(i / frames)
        for nm, (q, loc) in list(basis.items()):
            if nm in last and last[nm].dot(q) < 0:
                q = -q
                basis[nm] = (q, loc)
            last[nm] = q
        poser.key(basis, i)
    for fc in B.action_fcurves(act):
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    if report is not None:
        report[name] = frames / FPS


# ============================================================ splayed legs


class ArthroPoser(B.Poser):
    """Poser whose `arthro` legs are solved in the vertical plane through the
    hip and the foot. The target is (tip, meta angle, tarsus angle): the two
    lowest segments as angles in degrees from straight down, positive out
    along the leg. The knee bends up out of that plane's lower half."""

    def _solve_leg(self, leg, hip, target, M):
        info = self.legs[leg]
        if info.get("kind") != "arthro":
            return super()._solve_leg(leg, hip, target, M)
        up, lo, meta, toe = info["chain"]
        tip, am, at = target
        tip = V(tip)
        l1, l2 = self.length[up], self.length[lo]
        lm, lt = self.length[meta], self.length[toe]
        h = tip - hip
        h.z = 0.0
        u = h.normalized() if h.length > 1e-5 else V(info["u0"])
        n = u.cross(V((0, 0, 1)))
        down = V((0, 0, -1))
        am, at = math.radians(am), math.radians(at)
        tdir = (down * math.cos(at) + u * math.sin(at)).normalized()
        mdir = (down * math.cos(am) + u * math.sin(am)).normalized()
        base = tip - tdir * lt
        ankle = base - mdir * lm
        d_vec = ankle - hip
        d = d_vec.length
        reach = (l1 + l2) * 0.999
        if d > reach:
            if d - reach > self.overreach:
                self.worst = (leg, round(d - reach, 4))
            self.overreach = max(self.overreach, d - reach)
            d_vec = d_vec * (reach / d)
            d = reach
            ankle = hip + d_vec
            base = ankle + mdir * lm
        d = max(d, abs(l1 - l2) + 1e-4)
        w = d_vec.normalized()
        hint = V((0, 0, 1))
        v = hint - w * hint.dot(w)
        v = v.normalized() if v.length > 1e-6 else u
        ca = max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)))
        knee = hip + (w * ca + v * math.sqrt(max(0.0, 1 - ca * ca))) * l1
        for (name, head, tail) in ((up, hip, knee), (lo, knee, ankle), (meta, ankle, base),
                                   (toe, base, base + tdir * lt)):
            M["_ik_" + name] = plane_frame(head, tail, n)


def plane_frame(head, tail, n):
    y = (V(tail) - V(head)).normalized()
    x = V(n) - y * V(n).dot(y)
    if x.length < 1e-6:
        x = V((0, 0, 1)).cross(y)
    x.normalize()
    z = x.cross(y)
    m = mathutils.Matrix((x, y, z)).transposed().to_4x4()
    m.translation = V(head)
    return m


def splay_leg(hip, angle, reach, knee_h, ankle_h, base_h, hip_h, frac=(0.36, 0.74, 0.9)):
    """Landmarks of one left leg in (side, forward, up): from the hip, out at
    `angle` degrees from straight ahead, up to a knee, down to the foot at
    `reach` from the hip. Returns [hip, knee, ankle, base, tip]."""
    a = math.radians(angle)
    d = (math.sin(a), math.cos(a))
    s0, f0 = hip
    pts = [(s0, f0, hip_h)]
    for k, zz in zip(frac, (knee_h, ankle_h, base_h)):
        pts.append((s0 + d[0] * reach * k, f0 + d[1] * reach * k, zz))
    pts.append((s0 + d[0] * reach, f0 + d[1] * reach, 0.0))
    return pts


def arthro_bones(root, extra, legs):
    """Bone table: `root` (name, head, tail), `extra` [(name, head, tail,
    parent)] in (side, forward, up), and legs {base name: left landmarks},
    mirrored for the right, each chained femur-tibia-meta-tarsus with its
    local X on the leg plane's normal."""
    bones = [(root[0], P(*root[1]), P(*root[2]), None)]
    for (nm, h, t, par) in extra:
        bones.append((nm, P(*h), P(*t), par))
    for base, (pts, parent) in legs.items():
        for side, tag in ((1, ".L"), (-1, ".R")):
            q = [B.apply_side(p, side) for p in pts]
            u = V(P(*q[-1])) - V(P(*q[0]))
            u.z = 0
            n = u.normalized().cross(V((0, 0, 1)))
            par = parent
            for i, seg in enumerate(("femur", "tibia", "meta", "tarsus")):
                nm = "%s%s%s" % (seg, base, tag)
                bones.append((nm, P(*q[i]), P(*q[i + 1]), par, tuple(n)))
                par = nm
    return bones


def arthro_legs(legs):
    out = {}
    for base, (pts, _) in legs.items():
        for side, tag in ((1, ".L"), (-1, ".R")):
            q = [B.apply_side(p, side) for p in pts]
            u = V(P(*q[-1])) - V(P(*q[0]))
            u.z = 0
            out["leg%s%s" % (base, tag)] = dict(
                chain=["%s%s%s" % (s, base, tag) for s in ("femur", "tibia", "meta", "tarsus")],
                bend=V((0, 0, 1)), kind="arthro", u0=tuple(u.normalized()))
    return out


def arthro_rest(poser):
    rest = {}
    for leg, info in poser.legs.items():
        up, lo, meta, toe = info["chain"]
        tip = poser.rest_tail(toe)
        hip = poser.rest[up].translation.copy()
        u = tip - hip
        u.z = 0
        u.normalize()
        down = V((0, 0, -1))

        def angle(bone):
            y = poser.rest[bone].col[1].xyz.normalized()
            return math.degrees(math.atan2(y.dot(u), y.dot(down)))
        rest[leg] = dict(tip=tip, hip=hip, u=u, am=angle(meta), at=angle(toe),
                         reach=(tip - hip).length)
    return rest


def foot_at(rest, leg, fwd=0.0, up=0.0, out=0.0, am=0.0, at=0.0):
    """An arthro IK target: the rest foot moved forward, up and out along its
    own leg, the two low segments tipped out by (am, at) degrees."""
    r = rest[leg]
    tip = r["tip"] + V((0, -fwd, up)) + r["u"] * out
    return (tip, r["am"] + am, r["at"] + at)


def arthro_gait(rest, t, stride, duty, lift, offsets, tuck=14.0):
    ik = {}
    for leg, off in offsets.items():
        f, h, on, x = B.step(t + off, stride, duty, lift)
        k = 0.0 if on else math.sin(math.pi * x)
        # A swinging leg folds in a little as it lifts, the way a spider's
        # does -- a leg carried out stiff reads as a pencil on a string.
        ik[leg] = foot_at(rest, leg, fwd=f, up=h, out=-0.08 * rest[leg]["reach"] * k, am=-tuck * k, at=-tuck * 0.7 * k)
    return ik


def arthro_slip(tracks, stride, frames, duty, offsets):
    return B.foot_slip(tracks, stride, frames, duty, offsets)


def arthro_clips(arm, spec):
    """idle, walk, run, attack, hit, death for anything on `arthro` legs. The
    gait table names the leg phases; the rest is proportioned from the rig."""
    g = spec["gait"]
    poser = ArthroPoser(arm, spec["legs"])
    rest = arthro_rest(poser)
    clip = B.Clip(poser)
    bones = {b.name for b in arm.data.bones}
    root = spec["root"]
    height = poser.rest[root].translation.z
    offsets = g["phases"]
    front = [leg for leg in rest if leg[3] == "1"]
    report = {}
    fk_extra = g.get("fk", lambda t, mode, k: {})
    track = {leg: poser.legs[leg]["chain"][3] for leg in poser.legs}

    def idle(t):
        breath = wave(2 * t)
        fk = {root: (0.8 * breath, 1.5 * wave(t, 0.1), 0)}
        fk.update(fk_extra(t, "idle", 0.0))
        ik = {leg: foot_at(rest, leg) for leg in rest}
        # Now and then one front leg lifts and taps -- a spider tasting the air.
        tap = math.exp(-((t - 0.35) * 14) ** 2)
        for leg in front[:1]:
            ik[leg] = foot_at(rest, leg, up=height * 0.35 * tap, am=-20 * tap)
        return dict(fk=fk, loc=V((0, 0, height * 0.01 * breath)), ik=ik)
    clip.run("idle", g.get("idle_frames", 90), idle, step=2)

    S, N, duty, lift = g["walk_stride"], g["walk_frames"], g["walk_duty"], g["lift"]

    def walk(t):
        ik = arthro_gait(rest, t, S, duty, lift, offsets)
        fk = {root: (0, 1.2 * wave(2 * t), 1.5 * wave(2 * t, 0.25))}
        fk.update(fk_extra(t, "walk", 0.0))
        return dict(fk=fk, loc=V((0, 0, height * 0.02 * wave(2 * t, 0.2))), ik=ik)
    tracks = clip.run("walk", N, walk, track=track)
    report["walk"] = arthro_slip(tracks, S, N, duty, offsets)

    S2, N2, duty2 = g["run_stride"], g["run_frames"], g["run_duty"]

    def run(t):
        ik = arthro_gait(rest, t, S2, duty2, lift * 1.4, offsets)
        fk = {root: (2, 2 * wave(2 * t), 2 * wave(2 * t, 0.25))}
        fk.update(fk_extra(t, "run", 0.0))
        return dict(fk=fk, loc=V((0, 0, -height * 0.08 + height * 0.03 * wave(2 * t, 0.2))), ik=ik)
    tracks = clip.run("run", N2, run, track=track)
    report["run"] = arthro_slip(tracks, S2, N2, duty2, offsets)

    # -- attack: rear up on the back legs, front legs raised, then drive down.
    rear = g.get("rear", 1.0)

    def attack(t):
        cock = ease(t / 0.35) * (1 - ease((t - 0.4) / 0.12))
        strike = ease((t - 0.38) / 0.12) * (1 - ease((t - 0.62) / 0.38))
        fk = {root: (-g.get("rear_pitch", 22) * cock * rear + 8 * strike, 0, 0)}
        fk.update(fk_extra(t, "attack", strike))
        ik = {}
        for leg in rest:
            n = int(leg[3])
            if n == 1 or (n == 2 and g.get("rear_two", False)):
                ik[leg] = foot_at(rest, leg, fwd=height * (0.35 * cock + 0.3 * strike) * rear,
                                  up=height * (1.1 * cock * rear), out=-0.1 * rest[leg]["reach"] * cock,
                                  am=-40 * cock, at=-30 * cock)
            else:
                ik[leg] = foot_at(rest, leg)
        loc = V((0, -height * 0.3 * strike, height * 0.25 * cock * rear - height * 0.1 * strike))
        return dict(fk=fk, loc=loc, ik=ik)
    clip.run("attack", g.get("attack_frames", 21), attack)

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.3)) if t < 0.3 else (1 - ease((t - 0.3) / 0.7)) * 0.85
        fk = {root: (-8 * k, 6 * k, 5 * k)}
        fk.update(fk_extra(t, "hit", k))
        ik = {leg: foot_at(rest, leg, out=-0.06 * rest[leg]["reach"] * k) for leg in rest}
        return dict(fk=fk, loc=V((0, height * 0.25 * k, height * 0.12 * k)), ik=ik)
    clip.run("hit", 11, hit)

    # -- death: the body settles and every leg curls in under it.
    def death(t):
        drop = ease(t / 0.4)
        curl = ease((t - 0.1) / 0.6)
        fk = {root: (6 * drop, 0, 4 * drop)}
        fk.update(fk_extra(t, "death", curl))
        ik = {}
        for leg in rest:
            r = rest[leg]
            ik[leg] = foot_at(rest, leg, out=-r["reach"] * 0.55 * curl, up=height * 0.45 * curl,
                              am=-70 * curl, at=-110 * curl)
        return dict(fk=fk, loc=V((0, 0, -height * 0.55 * drop)), ik=ik)
    clip.run("death", 36, death)

    report["clips"] = clip.report
    report["stride"] = {"walk": S, "run": S2}
    report["overreach"] = clip.reach
    report["hit"] = 0.5
    return report


# ============================================================ spiders


def spider_legs(scale=1.0, hip_h=0.15):
    """Four pairs, front to back, as (hip, angle from ahead, reach, knee height)."""
    s = scale
    table = [((0.045, 0.125), 38, 0.5, 0.3), ((0.06, 0.1), 72, 0.46, 0.29),
             ((0.06, 0.065), 110, 0.42, 0.27), ((0.048, 0.035), 148, 0.5, 0.3)]
    legs = {}
    for i, (hip, ang, reach, kh) in enumerate(table):
        pts = splay_leg((hip[0] * s, hip[1] * s), ang, reach * s, kh * s, 0.13 * s, 0.035 * s, hip_h * s)
        legs[str(i + 1)] = (pts, "body")
    return legs


def leg_part(pts, base, side, radii, h, tris, mat, mask_low=0.3, knobs=True, name="leg"):
    """One leg as its own little surface: round cones joint to joint, a knob at
    each joint, the dark-points mask rising towards the foot."""
    tag = ".L" if side > 0 else ".R"
    q = [B.apply_side(p, side) for p in pts]
    solids = []
    for i, seg in enumerate(("femur", "tibia", "meta", "tarsus")):
        nm = "%s%s%s" % (seg, base, tag)
        solids.append(cone(P(*q[i]), P(*q[i + 1]), radii[i], radii[i + 1], nm, blend=radii[i + 1] * 0.8,
                           mask=(0, mask_low * i / 3.0), group="leg"))
        if knobs and 0 < i < 4:
            solids.append(ell(P(*q[i]), (radii[i] * 1.18,) * 3, nm, blend=radii[i] * 0.6, mask=(0, mask_low * i / 3.0)))
    return B.sdf_part(solids, h, tris, name, mat, smooth=1, patch_fn=lambda co: np.zeros(len(co)))


def spider():
    """A hairy hunting spider, a metre across the legs: a round abdomen on a
    waist, a low cephalothorax with a crown of eight eyes, chelicerae hung
    with fangs, and eight jointed legs that stand the body in a cradle of
    knees. The viewer scales it; the sewer's 'small hairy spider' is half
    of this, the drider's is three times."""
    legs = spider_legs()
    root = ("body", (0, -0.02, 0.15), (0, 0.15, 0.15))
    extra = [("abdomen", (0, -0.02, 0.16), (0, -0.3, 0.2), "body"),
             ("fang.L", (0.022, 0.155, 0.14), (0.024, 0.18, 0.08), "body"),
             ("fang.R", (-0.022, 0.155, 0.14), (-0.024, 0.18, 0.08), "body"),
             ("palp.L", (0.035, 0.15, 0.13), (0.06, 0.24, 0.07), "body"),
             ("palp.R", (-0.035, 0.15, 0.13), (-0.06, 0.24, 0.07), "body")]
    body = [
        # Cephalothorax: low, broad, a raised head region in front.
        ell(P(0, 0.07, 0.155), (0.07, 0.085, 0.042), "body", blend=0.02),
        ell(P(0, 0.12, 0.17), (0.045, 0.045, 0.035), "body", blend=0.02),
        # The waist, then the abdomen -- the biggest thing about a spider.
        cone(P(0, -0.01, 0.16), P(0, -0.04, 0.17), 0.018, 0.022, ("grad", "body", "abdomen", P(0, 0, 0.16), P(0, -0.05, 0.17)), blend=0.012),
        ell(P(0, -0.15, 0.2), (0.095, 0.13, 0.09), "abdomen", blend=0.02, mask=(0.0, 0.0)),
        ell(P(0, -0.24, 0.19), (0.06, 0.06, 0.055), "abdomen", blend=0.03),
        # Chelicerae: two stout bulbs hanging from the front of the head.
        cone(P(0.02, 0.15, 0.15), P(0.022, 0.175, 0.105), 0.019, 0.013, "fang.L", blend=0.01),
        cone(P(-0.02, 0.15, 0.15), P(-0.022, 0.175, 0.105), 0.019, 0.013, "fang.R", blend=0.01),
    ]

    def masks(co, n, pale, dark):
        f = -co[:, 1]
        # A pale chevron down the back of the abdomen and a darker underside.
        top = np.clip((n[:, 2] - 0.55) / 0.3, 0, 1) * (f < -0.04)
        chevron = top * (np.abs(co[:, 0]) < 0.018 + 0.1 * np.clip(-0.12 - f, 0, 1) * (np.sin(f * 90) > 0.3))
        under = np.clip((-n[:, 2] - 0.3) / 0.4, 0, 1)
        return np.maximum(pale, chevron * 0.8), np.maximum(dark, under * 0.6)

    def parts(body_solids):
        out = []
        for base, (pts, _) in legs.items():
            r = [0.021, 0.018, 0.0135, 0.01, 0.0055]
            for side in (1, -1):
                out.append(leg_part(pts, base, side, r, 0.0035, 300, "chitin", name="leg"))
        # Pedipalps: two short feelers in front of the fangs.
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            a, b = V(B.apply_side((0.035, 0.15, 0.13), side)), V(B.apply_side((0.06, 0.24, 0.07), side))
            mid = a.lerp(b, 0.5) + V((0, 0, 0.03))
            s = [cone(P(*a), P(*mid), 0.009, 0.008, "palp" + t, blend=0.004, group="p"),
                 cone(P(*mid), P(*b), 0.008, 0.006, "palp" + t, blend=0.004, group="p")]
            out.append(B.sdf_part(s, 0.003, 140, "palp", "chitin", smooth=1, patch_fn=lambda co: np.zeros(len(co))))
            # Fangs: black hooks folded back under the chelicerae.
            f0 = V(B.apply_side((0.022, 0.176, 0.106), side))
            fang = [cone(P(*f0), P(f0.x * 0.6, f0.y - 0.01, f0.z - 0.03), 0.007, 0.0015, "fang" + t, blend=0.002)]
            out.append(B.solid_part(fang, 0.0015, 60, "fang", "horn", (0.03, 0.025, 0.02), smooth=0))
        # Eight eyes: two big ones forward, a row of four, two on top.
        eyes = []
        for (s, f, u, r) in ((0.014, 0.16, 0.19, 0.011), (0.03, 0.15, 0.19, 0.007), (0.009, 0.152, 0.2, 0.006),
                             (0.022, 0.13, 0.2, 0.008)):
            for side in (1, -1):
                at = B.surface_point(body_solids, P(side * s, f + 0.04, u + 0.03), P(0, -0.8, -0.6), sink=r * 0.4)
                eyes.append(ell(tuple(at), (r, r, r), "body", blend=0.0))
        out.append(B.solid_part(eyes, 0.0015, 360, "eyes", "horn", (0.02, 0.018, 0.02), smooth=0))
        return out

    return dict(name="beast_spider", archetype="spider", body=body, masks=masks, parts=parts,
                patch=B.spots(0.03, seed=41), h=0.004, tris=1500, mat="chitin",
                bones=arthro_bones(root, extra, legs), legs=arthro_legs(legs), root="body",
                clips=arthro_clips,
                gait=dict(walk_stride=0.22, walk_frames=14, walk_duty=0.6, lift=0.05,
                          run_stride=0.42, run_frames=10, run_duty=0.5,
                          phases=tetrapod(), rear=1.0))


def tetrapod(lag=0.08):
    """Alternating tetrapod: L1 R2 L3 R4 together, the rest half a cycle
    later, each pair a little behind the one in front -- the wave that runs
    down a walking spider's side."""
    out = {}
    for i in range(1, 5):
        a = 0.0 if i % 2 else 0.5
        out["leg%d.L" % i] = (a + lag * (i - 1)) % 1.0
        out["leg%d.R" % i] = (a + 0.5 + lag * (i - 1)) % 1.0
    return out


def tripod():
    """Alternating tripod: L1 R2 L3 against R1 L2 R3."""
    out = {}
    for i in range(1, 4):
        a = 0.0 if i % 2 else 0.5
        out["leg%d.L" % i] = a
        out["leg%d.R" % i] = (a + 0.5) % 1.0
    return out


# ============================================================ beetle, scorpion


def chain_solids(pts, names, radii, blend, group, mask=(0, 0), squash=None):
    """Round cones joint to joint along `pts`, one bone each, joined hard."""
    out = []
    for i in range(len(pts) - 1):
        out.append(cone(P(*pts[i]), P(*pts[i + 1]), radii[i], radii[i + 1], names[i], blend=blend,
                        group=group, mask=mask, squash=squash))
    return out


def beetle():
    """A ground beetle half a metre long: a domed shell of wing cases split
    down the middle, a flat shield over the thorax, a broad head with a pair
    of hooked mandibles, elbowed antennae, and six legs set close under the
    body. The sewer's 'giant earth beetle' is this at twice the size."""
    legs = {}
    table = [((0.05, 0.12), 40, 0.21, 0.15), ((0.06, 0.06), 88, 0.2, 0.14), ((0.06, 0.0), 136, 0.25, 0.15)]
    for i, (hip, ang, reach, kh) in enumerate(table):
        legs[str(i + 1)] = (splay_leg(hip, ang, reach, kh, 0.07, 0.018, 0.075, frac=(0.3, 0.72, 0.9)), "body")
    root = ("body", (0, -0.04, 0.1), (0, 0.14, 0.1))
    extra = [("head", (0, 0.15, 0.1), (0, 0.25, 0.09), "body"),
             ("mandible.L", (0.03, 0.24, 0.08), (0.02, 0.33, 0.075), "head"),
             ("mandible.R", (-0.03, 0.24, 0.08), (-0.02, 0.33, 0.075), "head"),
             ("antenna.L", (0.035, 0.24, 0.11), (0.08, 0.32, 0.16), "head"),
             ("antenna2.L", (0.08, 0.32, 0.16), (0.12, 0.42, 0.14), "antenna.L"),
             ("antenna.R", (-0.035, 0.24, 0.11), (-0.08, 0.32, 0.16), "head"),
             ("antenna2.R", (-0.08, 0.32, 0.16), (-0.12, 0.42, 0.14), "antenna.R")]
    body = [
        # Elytra: one dome, creased along the suture by a thin negative slab.
        ell(P(0, -0.06, 0.115), (0.105, 0.17, 0.075), "body", blend=0.015),
        ell(P(0, -0.2, 0.1), (0.075, 0.07, 0.05), "body", blend=0.03),
        ell(P(0, -0.07, 0.195), (0.004, 0.2, 0.014), "body", blend=0.006, neg=True),
        # Pronotum: a flat shield, wider than the head, a waist behind it.
        ell(P(0, 0.12, 0.11), (0.075, 0.05, 0.045), "body", blend=0.012),
        ell(P(0, 0.065, 0.1), (0.05, 0.03, 0.035), "body", blend=0.01),
        # Underside: the thorax the legs come out of.
        ell(P(0, 0.05, 0.075), (0.06, 0.1, 0.03), "body", blend=0.02),
        # Head.
        ell(P(0, 0.2, 0.1), (0.052, 0.05, 0.035), "head", blend=0.012),
    ]

    def masks(co, n, pale, dark):
        u = co[:, 2]
        under = np.clip((-n[:, 2] - 0.2) / 0.4, 0, 1)
        # Striae: the grooves that run the length of a ground beetle's shell.
        stripes = (np.sin(co[:, 0] * 150) > 0.7) * np.clip((n[:, 2] - 0.3) / 0.3, 0, 1) * (co[:, 1] > -0.03)
        return pale, np.maximum(dark, np.maximum(under * 0.7, stripes * 0.35))

    def parts(body_solids):
        out = []
        for base, (pts, _) in legs.items():
            for side in (1, -1):
                out.append(leg_part(pts, base, side, [0.018, 0.016, 0.013, 0.009, 0.006], 0.0028, 260, "chitin"))
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            # Mandibles: curved blades crossing in front of the mouth.
            m0 = V(B.apply_side((0.03, 0.235, 0.08), side))
            m1 = V(B.apply_side((0.036, 0.29, 0.078), side))
            m2 = V(B.apply_side((0.008, 0.335, 0.074), side))
            jaw = [cone(P(*m0), P(*m1), 0.014, 0.01, "mandible" + t, blend=0.004, group="m", squash=(1, 1, 0.6)),
                   cone(P(*m1), P(*m2), 0.01, 0.002, "mandible" + t, blend=0.004, group="m", squash=(1, 1, 0.6))]
            out.append(B.solid_part(jaw, 0.0022, 160, "mandible", "horn", (0.05, 0.04, 0.035)))
            a0 = V(B.apply_side((0.035, 0.24, 0.11), side))
            a1 = V(B.apply_side((0.08, 0.32, 0.16), side))
            a2 = V(B.apply_side((0.12, 0.42, 0.14), side))
            ant = [cone(P(*a0), P(*a1), 0.0045, 0.004, "antenna" + t, blend=0.002, group="a"),
                   cone(P(*a1), P(*a2), 0.004, 0.0035, "antenna2" + t, blend=0.002, group="a")]
            ant += [ell(P(*a1.lerp(a2, 0.2 * k)), (0.0055, 0.0055, 0.0055), "antenna2" + t, blend=0.002) for k in range(1, 5)]
            out.append(B.sdf_part(ant, 0.0016, 200, "antenna", "chitin", smooth=1, patch_fn=lambda co: np.zeros(len(co)),
                                  mask_fn=lambda co, n, p, d: (p, np.ones(len(co)) * 0.6)))
        out += B.eye_pair(body_solids, (0.08, 0.22, 0.11), (-0.9, -0.3, 0), 0.012, colour=(0.02, 0.02, 0.02),
                          sink=0.004, h=0.002, tris=70)
        return out

    def fk(t, mode, k):
        out = {}
        if mode == "idle":
            for side, tag in ((1, ".L"), (-1, ".R")):
                out["antenna" + tag] = (10 * wave(2 * t, 0.2 * side), 12 * wave(t, 0.3 * side) * side, 0)
                out["antenna2" + tag] = (8 * wave(3 * t, 0.1 * side), 0, 0)
        elif mode in ("walk", "run"):
            for side, tag in ((1, ".L"), (-1, ".R")):
                out["antenna" + tag] = (6 * wave(2 * t), 6 * side * wave(2 * t, 0.25), 0)
        elif mode == "attack":
            gape = ease(t / 0.3) * (1 - ease((t - 0.42) / 0.08))
            for side, tag in ((1, ".L"), (-1, ".R")):
                out["mandible" + tag] = (0, side * 35 * gape - side * 8 * k, 0)
                out["antenna" + tag] = (-20 * gape, 0, 0)
            out["head"] = (-10 * gape + 10 * k, 0, 0)
        elif mode == "death":
            for side, tag in ((1, ".L"), (-1, ".R")):
                out["antenna" + tag] = (25 * k, 0, 0)
        return out

    return dict(name="beast_beetle", archetype="beetle", body=body, masks=masks, parts=parts,
                patch=B.spots(0.05, seed=47), h=0.0035, tris=1800, mat="chitin",
                bones=arthro_bones(root, extra, legs), legs=arthro_legs(legs), root="body",
                clips=arthro_clips,
                gait=dict(walk_stride=0.13, walk_frames=14, walk_duty=0.62, lift=0.03,
                          run_stride=0.22, run_frames=10, run_duty=0.52, rear=0.35, rear_pitch=10,
                          phases=tripod(), fk=fk))


def scorpion():
    """A desert scorpion, half a metre from claws to the curl of its tail: a
    flat body of plates, eight legs, a pair of pincers carried forward, and
    the tail -- five segments and a sting -- arched up over its back. It
    strikes with the sting and grips with the claws."""
    legs = {}
    table = [((0.035, 0.08), 55, 0.2, 0.09), ((0.045, 0.055), 85, 0.21, 0.09),
             ((0.045, 0.03), 115, 0.22, 0.09), ((0.04, 0.005), 140, 0.24, 0.1)]
    for i, (hip, ang, reach, kh) in enumerate(table):
        legs[str(i + 1)] = (splay_leg(hip, ang, reach, kh, 0.045, 0.012, 0.05, frac=(0.32, 0.72, 0.9)), "body")
    tail = [(0, -0.13, 0.06), (0, -0.19, 0.1), (0, -0.22, 0.16), (0, -0.22, 0.22), (0, -0.19, 0.27), (0, -0.14, 0.29),
            (0, -0.1, 0.27)]
    tnames = ["tail%d" % (i + 1) for i in range(len(tail) - 1)]
    root = ("body", (0, -0.1, 0.055), (0, 0.1, 0.055))
    extra = []
    par = "body"
    for i, nm in enumerate(tnames):
        extra.append((nm, tail[i], tail[i + 1], par))
        par = nm
    claw = [(0.035, 0.1, 0.05), (0.1, 0.16, 0.06), (0.08, 0.24, 0.05), (0.07, 0.33, 0.045)]
    for side, tag in ((1, ".L"), (-1, ".R")):
        c = [B.apply_side(p, side) for p in claw]
        extra += [("arm" + tag, c[0], c[1], "body"), ("forearm" + tag, c[1], c[2], "arm" + tag),
                  ("claw" + tag, c[2], c[3], "forearm" + tag)]
    body = [
        ell(P(0, 0.05, 0.05), (0.045, 0.05, 0.022), "body", blend=0.01),
        ell(P(0, -0.04, 0.05), (0.05, 0.08, 0.024), "body", blend=0.012),
    ]
    # The mesosoma's plates: shallow ridges across the back.
    for i in range(6):
        f = 0.02 - i * 0.022
        body.append(ell(P(0, f, 0.066), (0.048 - i * 0.002, 0.009, 0.01), "body", blend=0.006))
    tail_r = [0.024, 0.021, 0.019, 0.018, 0.017, 0.016, 0.02]
    for i, nm in enumerate(tnames):
        body.append(cone(P(*tail[i]), P(*tail[i + 1]), tail_r[i], tail_r[i + 1], nm, blend=0.004, group="tail"))
        body.append(ell(P(*V(tail[i]).lerp(V(tail[i + 1]), 0.5)), (tail_r[i] * 1.12,) * 3, nm, blend=0.008))

    def masks(co, n, pale, dark):
        under = np.clip((-n[:, 2] - 0.2) / 0.4, 0, 1)
        return np.maximum(pale, under * 0.6), dark

    def parts(body_solids):
        out = []
        for base, (pts, _) in legs.items():
            for side in (1, -1):
                out.append(leg_part(pts, base, side, [0.009, 0.008, 0.0065, 0.005, 0.0035], 0.0022, 220, "chitin",
                                    mask_low=0.4))
        for side, tag in ((1, ".L"), (-1, ".R")):
            c = [V(B.apply_side(p, side)) for p in claw]
            arm = [cone(P(*c[0]), P(*c[1]), 0.01, 0.011, "arm" + tag, blend=0.004, group="a"),
                   cone(P(*c[1]), P(*c[2]), 0.011, 0.014, "forearm" + tag, blend=0.004, group="a")]
            # The chela: a swollen hand and two fingers.
            hand = c[2].lerp(c[3], 0.35)
            arm.append(ell(P(*hand), (0.025, 0.04, 0.017), "claw" + tag, blend=0.008))
            tip = c[3]
            arm.append(cone(P(*hand), P(tip.x + side * 0.012, tip.y, tip.z), 0.012, 0.003, "claw" + tag, blend=0.004))
            arm.append(cone(P(*hand), P(tip.x - side * 0.012, tip.y - 0.005, tip.z), 0.01, 0.003, "claw" + tag, blend=0.004))
            out.append(B.sdf_part(arm, 0.0022, 420, "claw", "chitin", smooth=1, patch_fn=lambda co: np.zeros(len(co))))
        # The sting: a bulb and a curved barb, glossy.
        t6 = V(tail[-1])
        sting = [ell(P(*t6), (0.018, 0.022, 0.016), tnames[-1], blend=0.004),
                 cone(P(*t6), P(t6.x, t6.y + 0.03, t6.z - 0.035), 0.009, 0.001, tnames[-1], blend=0.004)]
        out.append(B.solid_part(sting, 0.0018, 200, "sting", "horn", (0.35, 0.18, 0.08)))
        out += B.eye_pair(body_solids, (0.012, 0.085, 0.09), (0, 0, -1), 0.006, colour=(0.02, 0.02, 0.02),
                          sink=0.002, h=0.0015, tris=50)
        return out

    def fk(t, mode, k):
        out = {}
        # The tail sways in the idle and cocks up to strike.
        if mode == "idle":
            for i, nm in enumerate(tnames):
                out[nm] = (2 * wave(t, 0.1 * i), 3 * wave(t, 0.05 * i), 0)
            for side, tag in ((1, ".L"), (-1, ".R")):
                out["arm" + tag] = (0, 4 * side * wave(t, 0.3), 0)
        elif mode in ("walk", "run"):
            for i, nm in enumerate(tnames):
                out[nm] = (1.5 * wave(2 * t, 0.1 * i), 2 * wave(2 * t, 0.08 * i), 0)
        elif mode == "attack":
            cock = ease(t / 0.35) * (1 - ease((t - 0.4) / 0.1))
            for i, nm in enumerate(tnames):
                out[nm] = (-8 * cock + 18 * k * (i / len(tnames)), 0, 0)
            for side, tag in ((1, ".L"), (-1, ".R")):
                out["arm" + tag] = (0, -side * 20 * cock, 0)
                out["forearm" + tag] = (0, side * 25 * cock, 0)
        elif mode == "death":
            for i, nm in enumerate(tnames):
                out[nm] = (-12 * k, 10 * k, 0)
        return out

    return dict(name="beast_scorpion", archetype="scorpion", body=body, masks=masks, parts=parts,
                patch=B.spots(0.04, seed=53), h=0.0025, tris=1600, mat="chitin",
                bones=arthro_bones(root, extra, legs), legs=arthro_legs(legs), root="body",
                clips=arthro_clips,
                gait=dict(walk_stride=0.11, walk_frames=12, walk_duty=0.6, lift=0.025,
                          run_stride=0.22, run_frames=8, run_duty=0.5, rear=0.2, rear_pitch=6,
                          phases=tetrapod(0.06), fk=fk))


# ============================================================ drider


def drider():
    """Half drow, half spider: the spider's body and legs at the size of a
    horse, and where its head would be, a man's torso rising from the front
    of the carapace -- dark-skinned, white-haired, arms free for a sword.
    The spider's parts carry no mask (the coat is its chitin), the skin is the
    pale channel and the hair the points, so one look paints all three."""
    k = 2.6
    legs = spider_legs(scale=k, hip_h=0.15)
    root = ("body", (0, -0.02 * k, 0.15 * k), (0, 0.15 * k, 0.15 * k))
    wb, wt = (0, 0.15 * k, 0.17 * k), (0, 0.44, 0.8)
    extra = [("abdomen", (0, -0.02 * k, 0.16 * k), (0, -0.3 * k, 0.2 * k), "body"),
             ("waist", wb, wt, "body"),
             ("chest", wt, (0, 0.46, 1.2), "waist"),
             ("neck", (0, 0.46, 1.2), (0, 0.48, 1.32), "chest"),
             ("head", (0, 0.48, 1.32), (0, 0.5, 1.56), "neck")]
    arm = [(0.2, 0.44, 1.14), (0.26, 0.44, 0.86), (0.27, 0.56, 0.68), (0.27, 0.64, 0.6)]
    for side, tag in ((1, ".L"), (-1, ".R")):
        a = [B.apply_side(p, side) for p in arm]
        extra += [("shoulder" + tag, (side * 0.06, 0.45, 1.16), a[0], "chest"),
                  ("upperarm" + tag, a[0], a[1], "shoulder" + tag),
                  ("forearm" + tag, a[1], a[2], "upperarm" + tag),
                  ("hand" + tag, a[2], a[3], "forearm" + tag)]
    skin = (1.0, 0.0)
    body = [
        ell(P(0, 0.07 * k, 0.155 * k), (0.07 * k, 0.085 * k, 0.042 * k), "body", blend=0.05),
        ell(P(0, 0.12 * k, 0.17 * k), (0.05 * k, 0.05 * k, 0.04 * k), "body", blend=0.05),
        cone(P(0, -0.01 * k, 0.16 * k), P(0, -0.04 * k, 0.17 * k), 0.018 * k, 0.022 * k,
             ("grad", "body", "abdomen", P(0, 0, 0.16 * k), P(0, -0.05 * k, 0.17 * k)), blend=0.03),
        ell(P(0, -0.15 * k, 0.2 * k), (0.095 * k, 0.13 * k, 0.09 * k), "abdomen", blend=0.05),
        ell(P(0, -0.24 * k, 0.19 * k), (0.06 * k, 0.06 * k, 0.055 * k), "abdomen", blend=0.06),
        # The torso rises out of the carapace: hips sunk into it, a narrow
        # waist, the ribcage, shoulders and a neck.
        ell(P(0, 0.4, 0.62), (0.15, 0.11, 0.16), ("grad", "body", "waist", P(0, 0.4, 0.45), P(0, 0.44, 0.8)), blend=0.08, mask=skin),
        cone(P(0, 0.43, 0.72), P(0, 0.45, 0.95), 0.12, 0.14, ("grad", "waist", "chest", P(0, 0.43, 0.75), P(0, 0.45, 0.95)), blend=0.05, mask=skin, squash=(1, 0.72, 1)),
        ell(P(0, 0.455, 1.03), (0.17, 0.11, 0.14), "chest", blend=0.05, mask=skin),
        ell(P(0.06, 0.52, 1.05), (0.07, 0.04, 0.06), "chest", blend=0.03, mask=skin),
        ell(P(-0.06, 0.52, 1.05), (0.07, 0.04, 0.06), "chest", blend=0.03, mask=skin),
        ell(P(0, 0.45, 1.14), (0.2, 0.08, 0.05), "chest", blend=0.05, mask=skin),
        cone(P(0, 0.46, 1.16), P(0, 0.48, 1.33), 0.055, 0.045, ("grad", "chest", "neck", P(0, 0.46, 1.18), P(0, 0.48, 1.3)), blend=0.03, mask=skin),
        # Head: skull, jaw, a straight nose, the brow.
        ell(P(0, 0.49, 1.42), (0.082, 0.1, 0.105), "head", blend=0.03, mask=skin),
        ell(P(0, 0.535, 1.365), (0.06, 0.06, 0.05), "head", blend=0.025, mask=skin),
        ell(P(0, 0.565, 1.45), (0.06, 0.03, 0.02), "head", blend=0.015, mask=skin),
        cone(P(0, 0.575, 1.45), P(0, 0.6, 1.39), 0.012, 0.014, "head", blend=0.01, mask=skin),
    ]
    for side, tag in ((1, ".L"), (-1, ".R")):
        a = [B.apply_side(p, side) for p in arm]
        body += [ell(P(*a[0]), (0.07, 0.07, 0.07), "upperarm" + tag, blend=0.04, mask=skin),
                 cone(P(*a[0]), P(*a[1]), 0.05, 0.04, "upperarm" + tag, blend=0.02, group="arm" + tag, mask=skin),
                 cone(P(*a[1]), P(*a[2]), 0.04, 0.03, "forearm" + tag, blend=0.02, group="arm" + tag, mask=skin),
                 cone(P(*a[2]), P(*a[3]), 0.032, 0.028, "hand" + tag, blend=0.02, group="arm" + tag, mask=skin, squash=(0.6, 1, 1))]

    def masks(co, n, pale, dark):
        # The chevron on the abdomen, faint; nothing dark on the legs -- the
        # points channel is this creature's hair.
        return pale, dark * 0

    def parts(body_solids):
        out = []
        for base, (pts, _) in legs.items():
            r = [x * k for x in (0.021, 0.018, 0.0135, 0.01, 0.0055)]
            for side in (1, -1):
                out.append(leg_part(pts, base, side, r, 0.008, 320, "chitin", mask_low=0.0))
        # Hair: white, long, swept back from the brow and down the back.
        hair = [ell(P(0, 0.475, 1.45), (0.092, 0.108, 0.11), "head", blend=0.02),
                cone(P(0, 0.44, 1.44), P(0, 0.38, 1.12), 0.08, 0.05, ("grad", "head", "chest", P(0, 0.44, 1.4), P(0, 0.38, 1.15)), blend=0.03, squash=(1.1, 0.7, 1)),
                ell(P(0, 0.49, 1.36), (0.085, 0.06, 0.06), "head", blend=0.02, neg=True)]
        out.append(B.sdf_part(hair, 0.006, 700, "hair", "fur", smooth=1, patch_fn=lambda co: np.zeros(len(co)),
                              mask_fn=lambda co, n, p, d: (p * 0, np.ones(len(co)))))
        for side, tag in ((1, ".L"), (-1, ".R")):
            # Ears: long and pointed, laid back.
            e0 = V(B.apply_side((0.08, 0.48, 1.42), side))
            e1 = V(B.apply_side((0.13, 0.44, 1.5), side))
            ear = [cone(P(*e0), P(*e1), 0.022, 0.004, "head", blend=0.006, squash=(0.4, 1, 1), mask=skin)]
            out.append(B.sdf_part(ear, 0.003, 90, "ear", "fur", smooth=1, patch_fn=lambda co: np.zeros(len(co))))
        # Eyes: the red of a drow's, lit.
        for side in (1, -1):
            at = B.surface_point(body_solids, P(side * 0.034, 0.7, 1.43), P(0, -1, 0), sink=0.006)
            out.append(B.solid_part([ell(tuple(at), (0.011, 0.007, 0.006), "head", blend=0.002)],
                                    0.0022, 50, "eye", "glow", (1.0, 1.0, 1.0), smooth=0))
        # The spider's eyes, on the carapace in front of the waist.
        eyes = []
        for (s, f, r) in ((0.05, 0.28, 0.02), (0.085, 0.26, 0.014)):
            for side in (1, -1):
                at = B.surface_point(body_solids, P(side * s, f, 0.6), P(0, 0, -1), sink=r * 0.4)
                eyes.append(ell(tuple(at), (r, r, r), "body", blend=0.0))
        out.append(B.solid_part(eyes, 0.003, 200, "eyes", "horn", (0.02, 0.018, 0.02), smooth=0))
        return out

    def fk(t, mode, k_):
        out = {}
        if mode == "idle":
            look = 18 * wave(t, 0.1)
            out.update({"waist": (1.5 * wave(2 * t), look * 0.3, 0), "chest": (1 * wave(2 * t, 0.1), look * 0.2, 0),
                        "head": (3 * wave(t, 0.4), look * 0.5, 0)})
            for side, tag in ((1, ".L"), (-1, ".R")):
                out["upperarm" + tag] = (-6 + 3 * wave(2 * t, 0.2), 0, side * -6)
                out["forearm" + tag] = (-25, 0, 0)
        elif mode in ("walk", "run"):
            sw = 10 if mode == "walk" else 16
            out["waist"] = (-4 if mode == "run" else 0, 3 * wave(2 * t), 0)
            for side, tag in ((1, ".L"), (-1, ".R")):
                out["upperarm" + tag] = (sw * wave(2 * t, 0.25 if side > 0 else 0.75) - 5, 0, side * -6)
                out["forearm" + tag] = (-30, 0, 0)
        elif mode == "attack":
            cock = ease(t / 0.38) * (1 - ease((t - 0.42) / 0.1))
            out["waist"] = (-10 * cock + 14 * k_, -18 * cock + 20 * k_, 0)
            out["chest"] = (-6 * cock + 8 * k_, -10 * cock + 12 * k_, 0)
            out["upperarm.R"] = (-150 * cock + 40 * k_, 0, 20 * cock)
            out["forearm.R"] = (-40 * cock - 10 * k_, 0, 0)
            out["upperarm.L"] = (-30 * cock, 0, -15)
            out["forearm.L"] = (-50, 0, 0)
        elif mode == "hit":
            out["waist"] = (-14 * k_, 8 * k_, 0)
            out["chest"] = (-8 * k_, 0, 0)
            out["head"] = (-15 * k_, 10 * k_, 0)
        elif mode == "death":
            out["waist"] = (40 * k_, 0, 10 * k_)
            out["chest"] = (20 * k_, 0, 0)
            out["head"] = (25 * k_, 20 * k_, 0)
            for side, tag in ((1, ".L"), (-1, ".R")):
                out["upperarm" + tag] = (20 * k_, 0, side * -10 * k_)
        return out

    return dict(name="beast_drider", archetype="drider", body=body, masks=masks, parts=parts,
                patch=lambda co: np.zeros(len(co)), h=0.009, tris=3200, mat="chitin",
                bones=arthro_bones(root, extra, legs), legs=arthro_legs(legs), root="body",
                clips=arthro_clips,
                gait=dict(walk_stride=0.55, walk_frames=22, walk_duty=0.6, lift=0.12,
                          run_stride=1.0, run_frames=14, run_duty=0.5, rear=0.25, rear_pitch=5,
                          phases=tetrapod(), fk=fk, idle_frames=120))


# ============================================================ bat


def bat():
    """A bat with a forty-centimetre span, built flying: the membrane is
    stretched between the arm, the long third finger and the ankle, with two
    more fingers ribbing it and a scalloped trailing edge. A pug face, big
    ears, a glint of teeth. It lives in the air -- `idle` is a hover and
    `walk` is flight -- at `hover` above the ground, which rides along in the
    file so the viewer can hang its name over it."""
    H = 0.06
    root = ("body", (0, -0.035, H), (0, 0.035, H))
    wing = [(0.014, 0.022, H + 0.006), (0.07, 0.0, H + 0.01), (0.13, 0.03, H + 0.008), (0.215, -0.02, H)]
    extra = [("head", (0, 0.035, H), (0, 0.07, H), "body")]
    for side, tag in ((1, ".L"), (-1, ".R")):
        w = [B.apply_side(p, side) for p in wing]
        extra += [("wing1" + tag, w[0], w[1], "body"), ("wing2" + tag, w[1], w[2], "wing1" + tag),
                  ("wing3" + tag, w[2], w[3], "wing2" + tag),
                  ("foot" + tag, B.apply_side((0.012, -0.035, H - 0.004), side), B.apply_side((0.022, -0.06, H - 0.006), side), "body")]
    bones = [(root[0], P(*root[1]), P(*root[2]), None)] + [(n, P(*h), P(*t), p) for (n, h, t, p) in extra]
    body = [
        ell(P(0, -0.005, H), (0.022, 0.04, 0.02), "body", blend=0.008),
        ell(P(0, 0.02, H + 0.002), (0.024, 0.022, 0.021), "body", blend=0.008),
        ell(P(0, 0.048, H + 0.004), (0.017, 0.017, 0.016), "head", blend=0.008),
        ell(P(0, 0.064, H + 0.0), (0.011, 0.011, 0.009), "head", blend=0.006, mask=(0, 0.5)),
    ]

    def masks(co, n, pale, dark):
        under = np.clip((-n[:, 2] - 0.2) / 0.5, 0, 1)
        return np.maximum(pale, under * 0.5), dark

    def parts(body_solids):
        out = []
        for side, tag in ((1, ".L"), (-1, ".R")):
            w = [V(B.apply_side(p, side)) for p in wing]
            arm = [cone(P(*w[0]), P(*w[1]), 0.005, 0.0035, "wing1" + tag, blend=0.002, group="a"),
                   cone(P(*w[1]), P(*w[2]), 0.0035, 0.0025, "wing2" + tag, blend=0.002, group="a"),
                   cone(P(*w[2]), P(*w[3]), 0.0022, 0.0012, "wing3" + tag, blend=0.002, group="a")]
            # Two more fingers fanning back from the wrist.
            for (fs, ff) in ((0.19, -0.075), (0.13, -0.085)):
                tip = V(B.apply_side((fs, ff, H - 0.002), side))
                arm.append(cone(P(*w[2]), P(*tip), 0.002, 0.001, "wing3" + tag, blend=0.002, group="f%d" % int(fs * 100)))
            # The membrane: a fan of flat lobes, each spanning from a joint
            # to a finger tip, so the trailing edge scallops in between them
            # the way a real one sags between its fingers.
            sq = (1, 1, 0.07)
            w3 = (0.13, 0.03)
            lobes = [((0.015, -0.02), (0.08, -0.028), 0.036, 0.034, ("grad", "body", "wing1" + tag, P(side * 0.01, 0, H), P(side * 0.07, 0, H))),
                     ((0.07, -0.012), (0.125, -0.005), 0.036, 0.03, ("grad", "wing1" + tag, "wing2" + tag, P(side * 0.07, 0, H), P(side * 0.13, 0, H))),
                     (w3, (0.212, -0.018), 0.02, 0.004, "wing3" + tag),
                     (w3, (0.186, -0.072), 0.03, 0.008, "wing3" + tag),
                     (w3, (0.13, -0.082), 0.034, 0.01, ("grad", "wing2" + tag, "wing3" + tag, P(side * 0.1, 0, H), P(side * 0.14, 0, H))),
                     ((0.02, -0.04), (0.1, -0.075), 0.022, 0.018, ("grad", "body", "wing1" + tag, P(side * 0.01, 0, H), P(side * 0.07, 0, H)))]
            mem = [cone(P(side * a_[0], a_[1], H + 0.003), P(side * b_[0], b_[1], H + 0.003), ra, rb, bone,
                        blend=0.004, squash=sq) for (a_, b_, ra, rb, bone) in lobes]
            out.append(B.sdf_part(arm + mem, 0.0012, 700, "wing", "fur", smooth=1,
                                  patch_fn=lambda co: np.zeros(len(co)),
                                  mask_fn=lambda co, n, p, d: (p * 0, np.maximum(d, 0.75))))
            # Ears: tall leaves.
            e0 = V(B.apply_side((0.01, 0.045, H + 0.012), side))
            e1 = V(B.apply_side((0.022, 0.04, H + 0.042), side))
            ear = [cone(P(*e0), P(*e1), 0.01, 0.003, "head", blend=0.003, squash=(1, 0.35, 1), mask=(0, 0.4))]
            out.append(B.sdf_part(ear, 0.0009, 120, "ear", "fur", smooth=1, patch_fn=lambda co: np.zeros(len(co))))
            f0 = V(B.apply_side((0.012, -0.035, H - 0.004), side))
            f1 = V(B.apply_side((0.022, -0.06, H - 0.006), side))
            out.append(B.solid_part([cone(P(*f0), P(*f1), 0.003, 0.002, "foot" + tag, blend=0.002)], 0.001, 60,
                                    "foot", "horn", (0.12, 0.09, 0.08)))
            # Fangs.
            t0 = V(B.apply_side((0.005, 0.07, H - 0.004), side))
            out.append(B.solid_part([cone(P(*t0), P(t0.x, t0.y + 0.001, t0.z - 0.008), 0.0018, 0.0003, "head", blend=0.001)],
                                    0.0006, 40, "fang", "horn", (0.85, 0.82, 0.72), smooth=0))
        out += B.eye_pair(body_solids, (0.03, 0.06, H + 0.008), (-0.8, -0.5, 0), 0.0035, colour=(0.03, 0.02, 0.02),
                          sink=0.001, h=0.0006, tris=40)
        tip = B.surface_point(body_solids, P(0, 0.1, H), P(0, -1, 0))
        out.append(B.solid_part([ell(tuple(tip), (0.006, 0.003, 0.005), "head", blend=0.002)], 0.0008, 50,
                                "nose", "horn", (0.1, 0.06, 0.06)))
        return out

    return dict(name="beast_bat", archetype="bat", bones=bones, body=body, masks=masks, parts=parts,
                patch=lambda co: np.zeros(len(co)), h=0.0014, tris=1200, mat="fur",
                clips=bat_clips, hover=1.6, extras={"hover": 1.6},
                gait=dict(flap=8, walk_stride=0.64, run_stride=0.8, run_frames=6))


def bat_clips(arm, spec):
    poser = B.Poser(arm, {})
    clip = B.Clip(poser)
    g = spec["gait"]
    H0 = poser.rest["body"].translation.z
    hover = spec["hover"]
    report = {}

    def flap(t, amp=1.0, fold=0.0):
        fk = {}
        for tag in (".L", ".R"):
            down = math.cos(2 * math.pi * t)
            fk["wing1" + tag] = (48 * amp * down - 5, 0, 0)
            fk["wing2" + tag] = (22 * amp * math.cos(2 * math.pi * (t - 0.08)), 0, 0)
            # On the upstroke the hand half folds, which is what makes a bat
            # flicker rather than beat like a bird.
            up = max(0.0, math.sin(2 * math.pi * t))
            s = 1 if tag == ".L" else -1
            fk["wing3" + tag] = (28 * amp * math.cos(2 * math.pi * (t - 0.15)), -s * (25 * up * amp + 60 * fold), 0)
            fk["foot" + tag] = (20, 0, 0)
        return fk

    def air(t, speed=0.0, beats=1, amp=1.0, z=None):
        fk = flap(t * beats % 1.0, amp)
        fk["body"] = (-6 - 14 * speed, 0, 0)
        fk["head"] = (10 + 10 * speed, 0, 0)
        lift = 0.035 * math.sin(2 * math.pi * (t * beats - 0.1))
        loc = V((0, 0, (z if z is not None else hover) - H0 + lift))
        return dict(fk=fk, loc=loc)

    # idle: a hover with a slow drift, three beats a second or so.
    clip.run("idle", 64, lambda t: (lambda d: (d["loc"].__iadd__(V((0.06 * wave(t), 0.04 * wave(t, 0.25), 0.05 * wave(t, 0.1)))), d)[1])(air(t, 0.0, 8)))
    clip.run("walk", g["flap"], lambda t: air(t, 1.0))
    clip.run("fly", g["flap"], lambda t: air(t, 1.0))
    clip.run("run", g["run_frames"], lambda t: air(t, 1.3, 1, 1.1))

    def attack(t):
        dive = ease(t / 0.45) * (1 - ease((t - 0.55) / 0.45))
        d = air(t, 0.5, 3, 1.1, z=hover - 0.5 * dive)
        d["fk"]["body"] = (20 * dive, 0, 0)
        d["fk"]["head"] = (25 * dive, 0, 0)
        d["loc"] += V((0, -0.25 * dive, 0))
        return d
    clip.run("attack", 24, attack)

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.3)) if t < 0.3 else (1 - ease((t - 0.3) / 0.7)) * 0.8
        d = air(t, 0.0, 2, 1.0 - 0.6 * k)
        d["fk"]["body"] = (-30 * k, 20 * k, 30 * k)
        d["loc"] += V((0, 0.12 * k, 0.06 * k))
        return d
    clip.run("hit", 12, hit)

    def death(t):
        fall = ease((t - 0.15) / 0.55) ** 1.6
        d = air(t, 0.0, 3, max(0.0, 1 - t * 3))
        z = lerp(hover, 0.0, fall)
        d["loc"] = V((0, 0, z - H0 + 0.004 - 0.004 * fall))
        crumple = ease((t - 0.55) / 0.3)
        for tag in (".L", ".R"):
            s = 1 if tag == ".L" else -1
            d["fk"]["wing1" + tag] = (-12 * crumple, s * 15 * crumple, 0)
            d["fk"]["wing3" + tag] = (-20 * crumple, -s * 50 * crumple, 0)
        d["fk"]["body"] = (0, 0, 0)
        d["fk"]["head"] = (-15 * crumple, 30 * crumple, 0)
        return d
    clip.run("death", 36, death)

    report["clips"] = clip.report
    report["stride"] = {"walk": g["walk_stride"], "run": g["run_stride"]}
    report["hit"] = 0.5
    return report


# ============================================================ the mud thing


def mudmonster():
    """A figure of mud two and a half metres tall, still rising out of the
    puddle it is made of: a sagging mass that narrows into a hunched torso,
    long arms that hang to its knees and end in clubs, strands dripping off
    them, and for a head a lump split by a wide maw, two embers deep in it.
    The lemure blob, the shambling mound and the Swamp Thing are this body at
    other sizes and in other matter -- the patch channel is the vegetation."""
    rng = np.random.default_rng(71)
    bones = [("base", P(0, -0.2, 0.06), P(0, 0.2, 0.06), None),
             ("spine1", P(0, 0, 0.12), P(0, 0.02, 0.75), "base"),
             ("spine2", P(0, 0.02, 0.75), P(0, 0.06, 1.35), "spine1"),
             ("spine3", P(0, 0.06, 1.35), P(0, 0.12, 1.78), "spine2"),
             ("head", P(0, 0.12, 1.78), P(0, 0.22, 2.3), "spine3"),
             ("jaw", P(0, 0.2, 1.98), P(0, 0.42, 1.86), "head")]
    arm = [(0.34, 0.1, 1.64), (0.56, 0.14, 1.2), (0.6, 0.24, 0.78), (0.6, 0.3, 0.5)]
    for side, tag in ((1, ".L"), (-1, ".R")):
        a = [B.apply_side(p, side) for p in arm]
        bones += [("arm1" + tag, P(*a[0]), P(*a[1]), "spine3"), ("arm2" + tag, P(*a[1]), P(*a[2]), "arm1" + tag),
                  ("hand" + tag, P(*a[2]), P(*a[3]), "arm2" + tag)]
    grad = lambda b0, b1, z0, z1: ("grad", b0, b1, P(0, 0, z0), P(0, 0, z1))
    body = [
        ell(P(0, 0.05, 0.03), (0.8, 0.8, 0.07), "base", blend=0.12, mask=(0, 0.8)),
        ell(P(0, 0.02, 0.4), (0.5, 0.46, 0.42), grad("base", "spine1", 0.1, 0.7), blend=0.25, mask=(0, 0.4)),
        ell(P(0, 0.05, 1.08), (0.4, 0.34, 0.45), grad("spine1", "spine2", 0.8, 1.3), blend=0.2),
        ell(P(0, 0.08, 1.55), (0.5, 0.36, 0.26), grad("spine2", "spine3", 1.35, 1.7), blend=0.18),
        ell(P(0, 0.2, 2.02), (0.26, 0.27, 0.3), "head", blend=0.14),
        ell(P(0, 0.34, 2.12), (0.19, 0.14, 0.12), "head", blend=0.08),
        # The maw: cut into the front of the head, wider than it is tall.
        ell(P(0, 0.42, 1.98), (0.16, 0.14, 0.075), "head", blend=0.05, neg=True),
    ]
    for side, tag in ((1, ".L"), (-1, ".R")):
        a = [B.apply_side(p, side) for p in arm]
        body += [cone(P(*a[0]), P(*a[1]), 0.19, 0.15, "arm1" + tag, blend=0.08, group="arm" + tag),
                 cone(P(*a[1]), P(*a[2]), 0.15, 0.13, "arm2" + tag, blend=0.08, group="arm" + tag),
                 ell(P(*a[3]), (0.17, 0.17, 0.22), "hand" + tag, blend=0.1)]
    # Lumps: the surface is not a solid's, it is mud settling.
    for i in range(22):
        z = rng.uniform(0.3, 1.9)
        ang = rng.uniform(0, 2 * math.pi)
        rr = 0.44 * (1.0 - 0.3 * (z > 1.5)) - 0.1 * (z > 0.8)
        c = (math.cos(ang) * rr, 0.05 + math.sin(ang) * rr * 0.8, z)
        bone = "spine1" if z < 0.75 else "spine2" if z < 1.35 else "spine3"
        r = rng.uniform(0.1, 0.2)
        body.append(ell(P(*c), (r, r, r * 0.75), bone, blend=0.07))

    def masks(co, n, pale, dark):
        u = co[:, 2]
        wet = np.clip((0.5 - u) / 0.45, 0, 1)
        return pale, np.maximum(dark, wet * 0.55)

    def parts(body_solids):
        out = []
        # The lower lip on the jaw, so the maw opens.
        jaw = [ell(P(0, 0.34, 1.88), (0.2, 0.14, 0.07), "jaw", blend=0.04)]
        out.append(B.sdf_part(jaw, 0.012, 260, "jaw", "ooze", smooth=1))
        mouth = [ell(P(0, 0.32, 1.96), (0.15, 0.1, 0.06), {"head": 0.5, "jaw": 0.5}, blend=0.02)]
        out.append(B.solid_part(mouth, 0.01, 120, "mouth", "horn", (0.2, 0.06, 0.05)))
        # Stones caught in the mud for teeth.
        teeth = []
        for i in range(7):
            x = -0.12 + i * 0.04
            teeth.append(cone(P(x, 0.43 - abs(x) * 0.5, 2.03), P(x * 1.05, 0.44 - abs(x) * 0.5, 1.975), 0.018, 0.005, "head",
                              blend=0.004, group="t%d" % i))
        for i in range(6):
            x = -0.1 + i * 0.04
            teeth.append(cone(P(x, 0.4 - abs(x) * 0.5, 1.9), P(x * 1.05, 0.41 - abs(x) * 0.5, 1.95), 0.016, 0.004, "jaw",
                              blend=0.004, group="b%d" % i))
        out.append(B.solid_part(teeth, 0.004, 400, "teeth", "horn", (0.5, 0.45, 0.34), smooth=0))
        # Eyes: embers sunk in the head over the maw.
        for side in (1, -1):
            at = B.surface_point(body_solids, P(side * 0.1, 0.8, 2.16), P(0, -1, 0), sink=0.03)
            out.append(B.solid_part([ell(tuple(at), (0.026, 0.018, 0.02), "head", blend=0.004)], 0.004, 60,
                                    "eye", "glow", (1.0, 1.0, 1.0), smooth=0))
        # Strands hanging off the arms and the jaw -- mud dripping, or weed.
        drips = []
        for i in range(10):
            side = 1 if i % 2 else -1
            tag = ".L" if side > 0 else ".R"
            k = rng.uniform(0.1, 0.9)
            a = [V(B.apply_side(p, side)) for p in arm]
            top = a[0].lerp(a[2], k) + V((side * 0.04, rng.uniform(-0.08, 0.02), -0.16))
            length = rng.uniform(0.25, 0.6)
            bone = "arm1" + tag if k < 0.5 else "arm2" + tag
            drips.append(cone(P(*top), P(top.x * 1.02, top.y + 0.02, top.z - length), 0.05, 0.018, bone,
                              blend=0.03, group="d%d" % i))
            drips.append(ell(P(top.x * 1.02, top.y + 0.02, top.z - length), (0.03, 0.03, 0.04), bone, blend=0.02))
        out.append(B.sdf_part(drips, 0.012, 900, "strands", "ooze", smooth=1, mask_fn=lambda co, n, p, d: (p, d + 0.25)))
        return out

    return dict(name="beast_mud", archetype="blob", bones=bones, body=body, masks=masks, parts=parts,
                patch=B.spots(0.12, seed=73), h=0.022, tris=3600, mat="ooze", clips=blob_clips,
                gait=dict(walk_stride=0.9, walk_frames=40, run_stride=1.5, run_frames=26))


def blob_clips(arm, spec):
    """A body with no feet: it shambles. The mass rolls forward over its
    base, leans and catches itself, sways side to side, the arms dragging a
    beat behind. There is no footfall to slip, so the stride is simply how
    far the lurch carries it per cycle."""
    g = spec["gait"]
    poser = B.Poser(arm, {})
    clip = B.Clip(poser)
    arms = [(tag, s) for tag, s in ((".L", 1), (".R", -1))]

    def pose(t, lean=0.0, sway=0.0, heave=0.0, swing=0.0, jaw=0.0, raise_=0.0, drop=0.0, curl=0.0):
        fk = {"base": (0, 0, 0),
              "spine1": (lean * 0.5 + heave, 0, sway),
              "spine2": (lean * 0.8 - heave * 0.5, sway * 0.4, sway * 0.6),
              "spine3": (lean + curl * 0.6, -sway * 0.6, sway * 0.4),
              "head": (8 - lean * 0.8 + heave * 2 + curl, -sway, 0),
              "jaw": (-jaw, 0, 0)}
        for tag, s in arms:
            ph = swing * (1 if s > 0 else -1)
            fk["arm1" + tag] = (ph - 150 * raise_ + 30 * drop, 0, s * (-10 * raise_ + 12 * drop))
            fk["arm2" + tag] = (-10 - 20 * abs(ph) / 30 - 30 * raise_ + 30 * drop, 0, 0)
            fk["hand" + tag] = (-10, 0, 0)
        return fk

    def idle(t):
        heave = 3 * wave(2 * t)
        fk = pose(t, lean=4 + 2 * wave(t, 0.3), sway=4 * wave(t), heave=heave, swing=5 * wave(t, 0.2),
                  jaw=6 * max(0.0, wave(2 * t, 0.4)))
        return dict(fk=fk, loc=V((0.02 * wave(t, 0.1), 0, 0.02 * wave(2 * t))))
    clip.run("idle", 120, idle, step=2)

    def shamble(t, run=False):
        # One lurch per half cycle, from one side to the other.
        k = 1.5 if run else 1.0
        lurch = 0.5 - 0.5 * math.cos(4 * math.pi * t)
        fk = pose(t, lean=(8 + 10 * lurch) * k, sway=9 * wave(t) * k, heave=-3 * lurch, swing=18 * wave(t, 0.1) * k,
                  jaw=4 * lurch)
        loc = V((0.06 * wave(t, 0.25) * k, -0.08 * wave(2 * t, 0.1) * k, -0.03 * lurch))
        return dict(fk=fk, loc=loc)
    clip.run("walk", g["walk_frames"], shamble)
    clip.run("run", g["run_frames"], lambda t: shamble(t, True))

    def attack(t):
        up = ease(t / 0.38) * (1 - ease((t - 0.42) / 0.08))
        slam = ease((t - 0.4) / 0.1) * (1 - ease((t - 0.66) / 0.34))
        fk = pose(t, lean=-10 * up + 30 * slam, heave=4 * up, raise_=up * 0.9 - slam * 0.1, drop=slam * 0.6,
                  jaw=35 * up + 10 * slam)
        return dict(fk=fk, loc=V((0, -0.35 * slam, 0.05 * up - 0.12 * slam)))
    clip.run("attack", 30, attack)

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.3)) if t < 0.3 else (1 - ease((t - 0.3) / 0.7)) * 0.8
        fk = pose(t, lean=-14 * k, sway=8 * k, heave=-5 * k, swing=-20 * k, jaw=20 * k)
        return dict(fk=fk, loc=V((0, 0.2 * k, -0.05 * k)))
    clip.run("hit", 14, hit)

    def death(t):
        # It goes back to the mud: the body folds down into its own base.
        k = ease(t / 0.8)
        fk = pose(t, lean=40 * k, sway=10 * k, heave=0, curl=30 * k, drop=0.9 * k, jaw=25 * ease(t / 0.3))
        fk["spine1"] = (60 * k, 0, 15 * k)
        fk["spine2"] = (50 * k, 0, 10 * k)
        return dict(fk=fk, loc=V((0, 0.2 * k, -1.2 * k)))
    clip.run("death", 50, death)

    return {"clips": clip.report, "stride": {"walk": g["walk_stride"], "run": g["run_stride"]}, "hit": 0.5}


# ============================================================ upright things


BIPED_LEGS = {k: v for k, v in B.quad_legs().items() if k.startswith("hind")}


def biped_bones(L):
    """Pelvis at the root pointing up the spine; legs on the hind chain so the
    beasts' IK and gait drive them unchanged; arms, and a tail and wings if
    the landmarks have them."""
    sp, nk = L["spine"], L["neck"]
    b = [("pelvis", P(*sp[0]), P(*sp[1]), None), ("spine", P(*sp[1]), P(*sp[2]), "pelvis"),
         ("chest", P(*sp[2]), P(*nk[0]), "spine"), ("neck", P(*nk[0]), P(*nk[1]), "chest"),
         ("head", P(*nk[1]), P(*L["crown"]), "neck")]
    if "jaw" in L:
        b.append(("jaw", P(*L["jaw"][0]), P(*L["jaw"][1]), "head"))
    for side, tag in ((1, ".L"), (-1, ".R")):
        a = [B.apply_side(p, side) for p in L["arm"]]
        c = B.apply_side(L["clavicle"], side)
        b += [("clavicle" + tag, P(*c), P(*a[0]), "chest"), ("uarm" + tag, P(*a[0]), P(*a[1]), "clavicle" + tag),
              ("farm" + tag, P(*a[1]), P(*a[2]), "uarm" + tag), ("hand" + tag, P(*a[2]), P(*a[3]), "farm" + tag)]
        q = [B.apply_side(p, side) for p in L["leg"]]
        par = "pelvis"
        for i, n in enumerate(B.LEG_BONES["hind"]):
            b.append((n + tag, P(*q[i]), P(*q[i + 1]), par))
            par = n + tag
        if "wing" in L:
            w = [B.apply_side(p, side) for p in L["wing"]]
            par = "chest"
            for i in range(len(w) - 1):
                b.append(("wing%d%s" % (i + 1, tag), P(*w[i]), P(*w[i + 1]), par))
                par = "wing%d%s" % (i + 1, tag)
    if "tail" in L:
        par = "pelvis"
        for i in range(len(L["tail"]) - 1):
            b.append(("tail%d" % (i + 1), P(*L["tail"][i]), P(*L["tail"][i + 1]), par))
            par = "tail%d" % (i + 1)
    return b


def limb(pts, names, radii, blend, group, mask=(0, 0), squash=None):
    return [cone(P(*pts[i]), P(*pts[i + 1]), radii[i], radii[i + 1], names[i], blend=blend, group=group,
                 mask=mask, squash=squash) for i in range(len(pts) - 1)]


def biped_limbs(L, arm_r, leg_r, blend, mask_hand=(0, 0), mask_foot=(0, 0)):
    out = []
    for side, tag in ((1, ".L"), (-1, ".R")):
        a = [B.apply_side(p, side) for p in L["arm"]]
        out += limb(a, ["uarm" + tag, "farm" + tag, "hand" + tag], arm_r, blend, "arm" + tag, squash=(0.85, 1, 1))
        q = [B.apply_side(p, side) for p in L["leg"]]
        out += limb(q, [n + tag for n in B.LEG_BONES["hind"]], leg_r, blend, "leg" + tag, squash=(0.85, 1, 1))
    return out


def biped_clips(arm, spec):
    """idle, walk, run, attack (a two-handed rake), hit, death (over
    backwards) -- and `fly` for anything with wings."""
    g = spec["gait"]
    poser = B.Poser(arm, BIPED_LEGS)
    rest = B.leg_rest(poser)
    clip = B.Clip(poser)
    bones = {b.name for b in arm.data.bones}
    tails = sorted([b for b in bones if b.startswith("tail")], key=lambda n: int(n[4:]))
    winged = "wing1.L" in bones
    hip = poser.rest["pelvis"].translation.z
    offsets = {"hind.L": 0.0, "hind.R": 0.5}
    flex = {"hind": g.get("flex", dict(lean=8, push=20, fold=45, curl=35))}
    hunch = g.get("hunch", 0.0)
    report = {}
    track = {leg: poser.legs[leg]["chain"][3] for leg in poser.legs}
    extra = g.get("fk", lambda t, mode, k: {})

    def arms(swing=0.0, bend=20.0, spread=8.0, raise_l=0.0, raise_r=0.0):
        fk = {}
        for tag, s in ((".L", 1), (".R", -1)):
            r = raise_l if s > 0 else raise_r
            fk["uarm" + tag] = (swing * s - r, 0, s * -spread)
            fk["farm" + tag] = (-bend - r * 0.3, 0, 0)
            fk["hand" + tag] = (-10, 0, 0)
        return fk

    def wings_fk(open_=0.0, flap=0.0):
        fk = {}
        if not winged:
            return fk
        for tag, s in ((".L", 1), (".R", -1)):
            fk["wing1" + tag] = (flap, -s * 30 * open_, 0)
            fk["wing2" + tag] = (flap * 0.5, s * 40 * open_, 0)
            fk["wing3" + tag] = (flap * 0.3, s * 20 * open_, 0)
        return fk

    def tail_fk(t, amp, pitch=0.0):
        return B.tail_wave(tails, t, amp, pitch=pitch)

    def idle(t):
        breath = wave(2 * t)
        look = 20 * wave(t, 0.15)
        fk = {"pelvis": (0, 0, 1.2 * wave(t)), "spine": (hunch * 0.5 + breath, 0, 0),
              "chest": (hunch * 0.5 + breath * 0.8, look * 0.2, 0), "neck": (-hunch * 0.6, look * 0.3, 0),
              "head": (-hunch * 0.4 + 3 * wave(t, 0.4), look * 0.5, 0)}
        fk.update(arms(swing=2 * wave(t, 0.3)))
        fk.update(tail_fk(t, 12))
        fk.update(wings_fk(0.0, 4 * breath))
        fk.update(extra(t, "idle", 0))
        return dict(fk=fk, loc=V((0.01 * wave(t), 0, hip * 0.004 * breath)), ik={leg: B.planted(rest, leg) for leg in rest})
    clip.run("idle", 120, idle, step=2)

    def locomote(t, S, duty, lift, run=False):
        ik, _ = B.gait_targets(rest, t, S, duty, lift, offsets, flex)
        k = 1.8 if run else 1.0
        fk = {"pelvis": (0, 6 * wave(t) * k, 3 * wave(t, 0.25)), "spine": (hunch * 0.5 + (6 if run else 0), -3 * wave(t), 0),
              "chest": (hunch * 0.5, -4 * wave(t) * k, 0), "neck": (-hunch * 0.6 - (6 if run else 0), 0, 0),
              "head": (-hunch * 0.4 + 2 * wave(2 * t), 2 * wave(t), 0)}
        fk.update(arms(swing=-16 * wave(t) * k, bend=25 + (30 if run else 0)))
        fk.update(tail_fk(t, 10, pitch=-8 if run else 0))
        fk.update(wings_fk(0.0, 3 * wave(2 * t)))
        fk.update(extra(t, "walk", 0))
        loc = V((0.012 * wave(t, 0.25), 0, -hip * (0.03 if not run else 0.08) + hip * 0.02 * wave(2 * t, 0.2) * k))
        return dict(fk=fk, loc=loc, ik=ik)
    S, N = g["walk_stride"], g["walk_frames"]
    tracks = clip.run("walk", N, lambda t: locomote(t, S, 0.62, g["lift"]), track=track)
    report["walk"] = B.foot_slip(tracks, S, N, 0.62, offsets)
    S2, N2 = g["run_stride"], g["run_frames"]
    tracks = clip.run("run", N2, lambda t: locomote(t, S2, 0.4, g["lift"] * 1.6, True), track=track)
    report["run"] = B.foot_slip(tracks, S2, N2, 0.4, offsets)

    def attack(t):
        up = ease(t / 0.38) * (1 - ease((t - 0.42) / 0.1))
        rake = ease((t - 0.4) / 0.12) * (1 - ease((t - 0.64) / 0.36))
        fk = {"spine": (hunch * 0.5 - 12 * up + 20 * rake, 0, 0), "chest": (hunch * 0.5 - 8 * up + 12 * rake, 0, 0),
              "neck": (-hunch * 0.6, 0, 0), "head": (-hunch * 0.4 + 10 * up - 10 * rake, 0, 0)}
        fk.update(arms(swing=0, bend=30 - 20 * rake, spread=14 * up, raise_l=130 * up - 60 * rake, raise_r=130 * up - 60 * rake))
        if "jaw" in bones:
            fk["jaw"] = (-25 * max(up, rake), 0, 0)
        fk.update(tail_fk(t, 6, pitch=10 * up))
        fk.update(wings_fk(0.8 * max(up, rake), 25 * up - 20 * rake))
        fk.update(extra(t, "attack", rake))
        loc = V((0, -hip * 0.25 * rake, -hip * 0.05 * rake))
        return dict(fk=fk, loc=loc, ik={leg: B.planted(rest, leg, fwd=0.0) for leg in rest})
    clip.run("attack", 24, attack)

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.3)) if t < 0.3 else (1 - ease((t - 0.3) / 0.7)) * 0.8
        fk = {"spine": (hunch * 0.5 - 10 * k, 5 * k, 0), "chest": (hunch * 0.5 - 8 * k, 0, 0),
              "neck": (-hunch * 0.6, 0, 0), "head": (-hunch * 0.4 - 18 * k, 12 * k, 0)}
        fk.update(arms(swing=-25 * k, bend=40 * k, spread=20 * k))
        fk.update(wings_fk(0.5 * k, -20 * k))
        fk.update(extra(t, "hit", k))
        return dict(fk=fk, loc=V((0, hip * 0.08 * k, 0)), ik={leg: B.planted(rest, leg) for leg in rest})
    clip.run("hit", 12, hit)

    lie = g.get("lie", hip * 0.18)

    def death(t):
        buckle = ease(t / 0.3)
        fall = ease((t - 0.15) / 0.5)
        fk = {"spine": (-10 * fall, 0, 0), "chest": (-6 * fall, 0, 0), "neck": (10 * fall, 0, 0), "head": (-20 * fall, 25 * fall, 0)}
        fk.update(arms(swing=-40 * fall, bend=30, spread=40 * fall))
        for tag in (".L", ".R"):
            fk["thigh" + tag] = (-30 * buckle, 0, 0)
            fk["shin" + tag] = (50 * buckle, 0, 0)
            fk["hock" + tag] = (-20, 0, 0)
        fk.update(wings_fk(0.6 * fall, -10 * fall))
        fk.update(extra(t, "death", fall))
        rot = mathutils.Quaternion(V((1, 0, 0)), math.radians(-88 * fall))
        loc = V((0, 0, lerp(0.0, -(hip - lie), fall) - hip * 0.2 * buckle * (1 - fall)))
        return dict(fk=fk, loc=loc, rot=rot, ik={leg: B.planted(rest, leg) for leg in rest},
                    limp=ease((t - 0.1) / 0.3))
    clip.run("death", 40, death)

    if winged:
        def fly(t):
            fk = {"spine": (20, 0, 0), "chest": (10, 0, 0), "neck": (-20, 0, 0), "head": (-10, 0, 0)}
            fk.update(arms(swing=-20, bend=40, spread=10))
            fk.update(wings_fk(1.0, 45 * math.cos(2 * math.pi * t)))
            fk.update(tail_fk(t, 10, pitch=-15))
            for tag in (".L", ".R"):
                fk["thigh" + tag] = (35, 0, 0)
                fk["shin" + tag] = (-60, 0, 0)
            return dict(fk=fk, loc=V((0, 0, hip * 1.2 + hip * 0.1 * math.sin(2 * math.pi * t))),
                        ik=None, limp=1.0)
        clip.run("fly", g.get("fly_frames", 10), fly)

    report["clips"] = clip.report
    report["stride"] = {"walk": S, "run": S2}
    report["overreach"] = clip.reach
    report["hit"] = 0.5
    return report


def myconoid():
    """A walking mushroom, two metres to the top of its cap: a thick pale
    stalk for a body that swells at the base into two stumpy legs, short
    arms of the same flesh, and a broad domed cap with gills underneath
    shading a face that is only two dark pits and a slit. The shaman is
    the same, larger. Cap is the coat, flesh the pale, gills the points."""
    hip = 0.55
    L = dict(spine=[(0, 0, hip), (0, 0, 0.85), (0, 0.01, 1.15)], neck=[(0, 0.01, 1.35), (0, 0.0, 1.5)],
             crown=(0, 0, 2.0), clavicle=(0.08, 0.0, 1.28),
             arm=[(0.24, 0.0, 1.26), (0.33, 0.04, 0.98), (0.35, 0.12, 0.76), (0.35, 0.16, 0.64)],
             leg=[(0.13, 0, hip - 0.02), (0.15, 0.04, 0.3), (0.15, -0.02, 0.08), (0.15, 0.08, 0.02), (0.15, 0.16, 0.0)])
    flesh = (1.0, 0.0)
    body = [
        # The stalk: a swollen base narrowing and widening again under the cap.
        ell(P(0, 0, 0.62), (0.28, 0.25, 0.28), ("grad", "pelvis", "spine", P(0, 0, 0.5), P(0, 0, 0.9)), blend=0.12, mask=flesh),
        cone(P(0, 0, 0.8), P(0, 0.01, 1.4), 0.24, 0.19, ("grad", "spine", "chest", P(0, 0, 0.85), P(0, 0, 1.3)), blend=0.1, mask=flesh),
        cone(P(0, 0.01, 1.35), P(0, 0.0, 1.62), 0.19, 0.22, ("grad", "chest", "head", P(0, 0, 1.35), P(0, 0, 1.6)), blend=0.08, mask=flesh),
        # The ring (annulus) hanging round the stalk below the cap.
        ell(P(0, 0.0, 1.5), (0.27, 0.26, 0.04), "neck", blend=0.04, mask=flesh),
    ]
    body += biped_limbs(L, [0.1, 0.085, 0.075, 0.07], [0.13, 0.11, 0.095, 0.08, 0.06], 0.06)

    def masks(co, n, pale, dark):
        return pale, dark

    def parts(body_solids):
        out = []
        # The cap: a dome with a rolled rim, gills under it (dark), on the head.
        cap = [ell(P(0, 0, 1.78), (0.62, 0.6, 0.3), "head", blend=0.06),
               ell(P(0, 0, 1.62), (0.6, 0.58, 0.12), "head", blend=0.08),
               ell(P(0, 0, 1.54), (0.56, 0.54, 0.1), "head", blend=0.04, neg=True)]

        def cap_mask(co, n, p, d):
            under = np.clip((-n[:, 2] - 0.2) / 0.4, 0, 1)
            return p * 0, under
        out.append(B.sdf_part(cap, 0.018, 1400, "cap", "fur", smooth=1, mask_fn=cap_mask, patch_fn=B.spots(0.1, seed=79)))
        # A face in the stalk under the cap: two pits and a slit, dark.
        face = []
        for side in (1, -1):
            at = B.surface_point(body_solids, P(side * 0.07, 0.6, 1.36), P(0, -1, 0), sink=0.02)
            face.append(ell(tuple(at), (0.03, 0.02, 0.04), "head", blend=0.004))
        at = B.surface_point(body_solids, P(0, 0.6, 1.23), P(0, -1, 0), sink=0.015)
        face.append(ell(tuple(at), (0.07, 0.015, 0.012), "chest", blend=0.004))
        out.append(B.solid_part(face, 0.006, 160, "face", "horn", (0.05, 0.035, 0.03), smooth=0))
        return out

    return dict(name="beast_myconoid", archetype="myconoid", bones=biped_bones(L), body=body, masks=masks,
                parts=parts, patch=lambda co: np.zeros(len(co)), h=0.02, tris=2600, mat="fur", clips=biped_clips,
                gait=dict(walk_stride=0.62, walk_frames=40, lift=0.07, run_stride=1.0, run_frames=26, lie=0.3))


def ratman():
    """A rat that stands: a hunched furry body on digitigrade legs, a long
    snout full of incisors, round naked ears, clawed hands held forward and a
    bare tail on the ground behind. One and a half metres upright. The
    sewer's wererats wear it in brown; the morkoth -- 'somewhere between a
    human and a rat', a shadow with hungry eyes -- in black, eyes lit."""
    hip = 0.72
    L = dict(spine=[(0, -0.02, hip), (0, 0.03, 0.98), (0, 0.1, 1.2)], neck=[(0, 0.16, 1.32), (0, 0.22, 1.38)],
             crown=(0, 0.45, 1.36), jaw=[(0, 0.25, 1.33), (0, 0.42, 1.29)], clavicle=(0.06, 0.12, 1.26),
             arm=[(0.19, 0.12, 1.24), (0.24, 0.12, 1.0), (0.21, 0.3, 0.92), (0.2, 0.38, 0.88)],
             leg=[(0.11, -0.02, hip - 0.04), (0.14, 0.14, 0.44), (0.13, -0.06, 0.16), (0.13, 0.03, 0.03), (0.13, 0.12, 0.0)],
             tail=[(0, -0.14, 0.72), (0, -0.32, 0.55), (0, -0.5, 0.3), (0, -0.7, 0.1), (0, -0.95, 0.03), (0, -1.2, 0.02)])
    body = [
        ell(P(0, 0.0, 0.82), (0.19, 0.17, 0.2), ("grad", "pelvis", "spine", P(0, 0, 0.72), P(0, 0.03, 1.0)), blend=0.08),
        ell(P(0, 0.07, 1.08), (0.2, 0.17, 0.2), ("grad", "spine", "chest", P(0, 0.03, 0.98), P(0, 0.1, 1.2)), blend=0.08),
        ell(P(0, 0.12, 1.22), (0.17, 0.13, 0.12), "chest", blend=0.06),
        cone(P(0, 0.14, 1.26), P(0, 0.22, 1.37), 0.1, 0.08, ("grad", "chest", "neck", P(0, 0.14, 1.28), P(0, 0.2, 1.36)), blend=0.05),
        # The head: a skull running out into a long snout, a pale throat.
        ell(P(0, 0.26, 1.39), (0.08, 0.1, 0.075), "head", blend=0.04),
        cone(P(0, 0.29, 1.38), P(0, 0.44, 1.32), 0.06, 0.022, "head", blend=0.03),
        ell(P(0, 0.2, 1.3), (0.07, 0.07, 0.06), "neck", blend=0.04, mask=(0.7, 0)),
        ell(P(0, 0.08, 1.02), (0.14, 0.1, 0.15), "spine", blend=0.06, mask=(0.5, 0)),
    ]
    body += biped_limbs(L, [0.06, 0.045, 0.035, 0.03], [0.1, 0.06, 0.04, 0.035, 0.025], 0.04)
    for side, tag in ((1, ".L"), (-1, ".R")):
        body.append(ell(P(side * 0.12, 0.02, 0.62), (0.08, 0.12, 0.14), "thigh" + tag, blend=0.06))

    def masks(co, n, pale, dark):
        u = co[:, 2]
        low = np.clip((0.2 - u) / 0.1, 0, 1)
        return pale, np.maximum(dark, low * 0.7)

    def parts(body_solids):
        out = []
        jaw = [cone(P(0, 0.27, 1.34), P(0, 0.41, 1.3), 0.035, 0.015, "jaw", blend=0.012, squash=(0.9, 1, 0.8))]
        out.append(B.sdf_part(jaw, 0.004, 160, "jaw", "fur", smooth=1, mask_fn=lambda co, n, p, d: (np.maximum(p, 0.6), d)))
        teeth = [cone(P(x, 0.43, 1.315), P(x, 0.44, 1.28), 0.007, 0.004, "head", blend=0.002, group="t%d" % i)
                 for i, x in enumerate((0.008, -0.008))]
        out.append(B.solid_part(teeth, 0.0015, 60, "teeth", "horn", (0.7, 0.55, 0.2), smooth=0))
        tip = B.surface_point(body_solids, P(0, 0.6, 1.33), P(0, -1, 0))
        out.append(B.solid_part([ell(tuple(tip), (0.016, 0.01, 0.012), "head", blend=0.004)], 0.003, 60, "nose", "horn",
                                (0.45, 0.28, 0.28)))
        for side, tag in ((1, ".L"), (-1, ".R")):
            e0 = V(B.apply_side((0.05, 0.22, 1.43), side))
            e1 = V(B.apply_side((0.1, 0.2, 1.5), side))
            out.append(B.sdf_part([cone(P(*e0), P(*e1), 0.04, 0.035, "head", blend=0.01, squash=(1, 0.3, 1))], 0.003, 140,
                                  "ear", "horn" if False else "fur", smooth=1, mask_fn=lambda co, n, p, d: (np.ones(len(co)) * 0.6, d)))
            # Claws on the hands.
            h = [V(B.apply_side(p, side)) for p in L["arm"]]
            cl = [cone(P(h[3].x + side * 0.012 * (k - 1), h[3].y, h[3].z), P(h[3].x + side * 0.015 * (k - 1), h[3].y + 0.05, h[3].z - 0.03),
                       0.008, 0.002, "hand" + tag, blend=0.002, group="c%d" % k) for k in range(3)]
            out.append(B.solid_part(cl, 0.002, 90, "claws", "horn", (0.12, 0.1, 0.08), smooth=0))
        for side in (1, -1):
            at = B.surface_point(body_solids, P(side * 0.14, 0.3, 1.42), P(-side * 0.8, -0.6, 0), sink=0.008)
            out.append(B.solid_part([ell(tuple(at), (0.014, 0.014, 0.012), "head", blend=0.003)], 0.0025, 60,
                                    "eye", "glow", (1.0, 1.0, 1.0), smooth=0))
        tail = L["tail"]
        s = [cone(P(*tail[i]), P(*tail[i + 1]), 0.04 - i * 0.007, 0.034 - i * 0.007, "tail%d" % (i + 1), blend=0.01, group="t")
             for i in range(len(tail) - 1)]
        out.append(B.solid_part(s, 0.005, 300, "tail", "horn", (0.5, 0.38, 0.36)))
        return out

    return dict(name="beast_ratman", archetype="ratman", bones=biped_bones(L), body=body, masks=masks, parts=parts,
                patch=B.spots(0.06, seed=83), h=0.012, tris=3200, mat="fur", clips=biped_clips,
                gait=dict(walk_stride=0.72, walk_frames=28, lift=0.08, run_stride=1.4, run_frames=18, hunch=18.0, lie=0.14))


def imp():
    """A winged imp half a metre tall -- the homonculus: man-shaped, green and
    scaled, a bat's mouth, horns, pointed ears, a whip of a tail and leathery
    wings half-raised behind. Built at its own size; the gargoyle is the same
    creature four times over and grey."""
    hip = 0.2
    L = dict(spine=[(0, 0, hip), (0, 0.005, 0.27), (0, 0.015, 0.33)], neck=[(0, 0.02, 0.37), (0, 0.025, 0.39)],
             crown=(0, 0.03, 0.47), jaw=[(0, 0.035, 0.4), (0, 0.075, 0.385)], clavicle=(0.02, 0.01, 0.355),
             arm=[(0.055, 0.01, 0.35), (0.07, 0.0, 0.28), (0.072, 0.04, 0.22), (0.072, 0.06, 0.2)],
             leg=[(0.03, 0, hip - 0.01), (0.04, 0.035, 0.12), (0.037, -0.02, 0.05), (0.037, 0.01, 0.01), (0.037, 0.04, 0.0)],
             tail=[(0, -0.03, 0.2), (0, -0.1, 0.14), (0, -0.17, 0.08), (0, -0.25, 0.05), (0, -0.32, 0.06)],
             wing=[(0.02, -0.03, 0.34), (0.1, -0.06, 0.44), (0.18, -0.07, 0.4), (0.26, -0.1, 0.5)])
    body = [
        ell(P(0, 0.0, 0.23), (0.045, 0.035, 0.04), ("grad", "pelvis", "spine", P(0, 0, 0.2), P(0, 0, 0.27)), blend=0.02),
        ell(P(0, 0.01, 0.3), (0.055, 0.04, 0.05), ("grad", "spine", "chest", P(0, 0, 0.27), P(0, 0, 0.33)), blend=0.02),
        ell(P(0, 0.015, 0.345), (0.06, 0.035, 0.025), "chest", blend=0.015),
        cone(P(0, 0.02, 0.35), P(0, 0.025, 0.39), 0.022, 0.018, "neck", blend=0.01),
        ell(P(0, 0.035, 0.42), (0.034, 0.036, 0.038), "head", blend=0.012),
        ell(P(0, 0.06, 0.4), (0.025, 0.022, 0.018), "head", blend=0.01),
        ell(P(0, 0.07, 0.395), (0.02, 0.012, 0.004), "head", blend=0.004, neg=True),
        ell(P(0, 0.02, 0.28), (0.035, 0.03, 0.04), "spine", blend=0.02, mask=(0.6, 0)),
    ]
    body += biped_limbs(L, [0.014, 0.011, 0.009, 0.007], [0.02, 0.014, 0.01, 0.009, 0.006], 0.01)

    def masks(co, n, pale, dark):
        return pale, dark

    def parts(body_solids):
        out = []
        jaw = [cone(P(0, 0.035, 0.395), P(0, 0.07, 0.385), 0.014, 0.008, "jaw", blend=0.004, squash=(1, 1, 0.7))]
        out.append(B.sdf_part(jaw, 0.0015, 120, "jaw", "hide", smooth=1, mask_fn=lambda co, n, p, d: (np.maximum(p, 0.5), d)))
        teeth = [cone(P(x, 0.07, 0.392), P(x, 0.072, 0.382), 0.0025, 0.0006, "head", blend=0.001, group="t%d" % i)
                 for i, x in enumerate((0.01, -0.01, 0.004, -0.004))]
        out.append(B.solid_part(teeth, 0.0006, 80, "teeth", "horn", (0.8, 0.7, 0.3), smooth=0))
        for side, tag in ((1, ".L"), (-1, ".R")):
            h0 = V(B.apply_side((0.018, 0.04, 0.45), side))
            horn = [cone(P(*h0), P(h0.x + side * 0.012, h0.y - 0.02, h0.z + 0.035), 0.007, 0.001, "head", blend=0.002)]
            out.append(B.solid_part(horn, 0.001, 70, "horn", "horn", (0.2, 0.16, 0.1)))
            e0 = V(B.apply_side((0.03, 0.03, 0.42), side))
            ear = [cone(P(*e0), P(e0.x + side * 0.035, e0.y - 0.01, e0.z + 0.02), 0.01, 0.001, "head", blend=0.003, squash=(1, 0.3, 1))]
            out.append(B.sdf_part(ear, 0.001, 70, "ear", "hide", smooth=1))
            w = [V(B.apply_side(p, side)) for p in L["wing"]]
            wing = limb([tuple(p) for p in w], ["wing1" + tag, "wing2" + tag, "wing3" + tag], [0.007, 0.005, 0.004, 0.002], 0.003, "w")
            sq = (1, 0.07, 1)
            base = V(B.apply_side((0.03, -0.04, 0.26), side))
            lobes = [(w[0], w[2], 0.05, 0.04, ("grad", "wing1" + tag, "wing2" + tag, P(*w[0]), P(*w[2]))),
                     (w[2], w[3], 0.035, 0.004, "wing3" + tag),
                     (w[2], V((w[2].x + side * 0.05, w[2].y - 0.02, 0.28)), 0.04, 0.01, "wing3" + tag),
                     (base, w[2], 0.03, 0.04, ("grad", "wing1" + tag, "wing2" + tag, P(*w[0]), P(*w[2])))]
            wing += [cone(P(*a_), P(*b_), ra, rb, bone, blend=0.004, squash=sq) for (a_, b_, ra, rb, bone) in lobes]
            out.append(B.sdf_part(wing, 0.0014, 600, "wing", "hide", smooth=1, patch_fn=lambda co: np.zeros(len(co)),
                                  mask_fn=lambda co, n, p, d: (p * 0, np.maximum(d, 0.6))))
        for side in (1, -1):
            at = B.surface_point(body_solids, P(side * 0.03, 0.12, 0.425), P(0, -1, 0), sink=0.004)
            out.append(B.solid_part([ell(tuple(at), (0.006, 0.005, 0.005), "head", blend=0.001)], 0.0012, 50,
                                    "eye", "glow", (1.0, 1.0, 1.0), smooth=0))
        tail = L["tail"]
        s = [cone(P(*tail[i]), P(*tail[i + 1]), 0.009 - i * 0.0015, 0.0075 - i * 0.0015, "tail%d" % (i + 1), blend=0.003, group="t")
             for i in range(len(tail) - 1)]
        tt = V(tail[-1])
        s.append(ell(P(tt.x, tt.y - 0.01, tt.z), (0.012, 0.018, 0.003), "tail%d" % (len(tail) - 1), blend=0.003))
        out.append(B.sdf_part(s, 0.0015, 200, "tail", "hide", smooth=1))
        return out

    return dict(name="beast_imp", archetype="imp", bones=biped_bones(L), body=body, masks=masks, parts=parts,
                patch=B.spots(0.02, seed=89), h=0.0028, tris=2400, mat="hide", clips=biped_clips,
                gait=dict(walk_stride=0.2, walk_frames=20, lift=0.025, run_stride=0.4, run_frames=12, hunch=8.0, fly_frames=8))


# ============================================================ previews and build


COATED = ("MAT:fur", "MAT:feather", "MAT:scales", "MAT:chitin", "MAT:ooze", "MAT:hide")


def preview_materials(coat, pale, dark, patch=None, threshold=0.55, glow=(1.0, 0.8, 0.2)):
    """beasts.preview_materials for every coated tag here, and `glow` unlit."""
    for mat in bpy.data.materials:
        if not mat.name.startswith("MAT:"):
            continue
        mat.use_nodes = True
        nt = mat.node_tree
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        attr = nt.nodes.new("ShaderNodeAttribute")
        attr.attribute_name = "Col"
        if mat.name == "MAT:glow":
            em = nt.nodes.new("ShaderNodeEmission")
            em.inputs[1].default_value = 6.0
            nt.links.new(attr.outputs["Color"], em.inputs[0])
            nt.links.new(em.outputs[0], out.inputs[0])
            continue
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
        if mat.name in COATED:
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(attr.outputs["Color"], sep.inputs[0])

            def mix(a, b, fac):
                m = nt.nodes.new("ShaderNodeMix")
                m.data_type = "RGBA"
                if isinstance(a, tuple):
                    m.inputs[6].default_value = a + (1,)
                else:
                    nt.links.new(a, m.inputs[6])
                m.inputs[7].default_value = b + (1,)
                nt.links.new(fac, m.inputs[0])
                return m.outputs[2]
            col = coat
            if patch:
                ramp = nt.nodes.new("ShaderNodeMapRange")
                ramp.inputs[1].default_value = threshold - 0.04
                ramp.inputs[2].default_value = threshold + 0.04
                nt.links.new(sep.outputs[2], ramp.inputs[0])
                col = mix(col, patch, ramp.outputs[0])
            col = mix(col, pale, sep.outputs[0])
            col = mix(col, dark, sep.outputs[1])
            nt.links.new(col, bsdf.inputs["Base Color"])
            bsdf.inputs["Roughness"].default_value = 0.55 if mat.name in ("MAT:chitin", "MAT:ooze") else 0.9
        else:
            nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
            bsdf.inputs["Roughness"].default_value = 0.3


def preview(spec_fn, path, target=None, dist=None, azim=35.0, elev=14.0, clip=None, frame=None,
            coat=(0.12, 0.1, 0.09), pale=(0.7, 0.66, 0.6), dark=(0.03, 0.03, 0.03), patch=None, thr=0.55,
            spec=None, built=None):
    """Render a creature (optionally mid-clip) to `path` for judging by eye."""
    if built is None:
        spec = spec or spec_fn()
        built = build_one(spec, export=False)
    arm, meshes, tris, rep = built
    if clip:
        arm.animation_data.action = bpy.data.actions[clip]
    bpy.context.scene.frame_set(frame or 0)
    preview_materials(coat, pale, dark, patch, thr)
    bb = [m.matrix_world @ V(c) for m in meshes for c in m.bound_box]
    lo = V((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = V((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    size = (hi - lo).length
    tgt = target or tuple((lo + hi) * 0.5)
    B.render(path, target=tgt, dist=dist or size * 1.5, azim=azim, elev=elev)
    return tris, rep


SPECS = [spider, beetle, scorpion, drider, bat, mudmonster, myconoid, ratman, imp]


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
