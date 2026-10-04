"""hybrids -- the bodies that are two things at once, and the made ones.

The stock areas have three kinds of mobile with a person's top half on an
animal's bottom half, and none of them was anything but a townsperson:

- the centaurs of Wyvern's Tower, 'the upper torso of a man and lower body of
  a horse' (and of a woman, for the two mares);
- the lamias of Thalos and its mirror, 'the upper torso of a beautiful woman,
  but the lower body of a four-legged beast' -- in the bestiary the mud draws
  on, a lion's;
- the harpies of Dylan's cloud, a woman's head and body on a bird's legs,
  with wings where her arms would be.

and the golems, which are a body made of something that is not flesh.

A taur is beasts.py's quadruped with its neck and head taken off and a
person's waist, chest, arms and head put on in front of the withers. The
animal's half is the animal's own -- the same anatomical solids, scaled to
the size a taur stands at, the same legs and gaits and the same IK -- so its
strides are measured exactly as a horse's and a lion's are. The person's half
is the people's: a face sculpted by heads.py and hair grown by hair.py, moved
from the people's canon onto the taur's neck, as monsters.py does for the
drider. The two halves are one surface, blended at the waist, and then cut
apart again along the waist into fur and skin so each wears its own surface.

Clips: everything beasts.quad_clips plays -- idle, walk, run, attack, hit,
death and the pastimes -- with the person's half posed over it per clip
(`TaurClip`): looking about, the arms swinging with the stride, a blow at the
hit frame, slumping in death. Where a pastime pitches the whole body (a rear,
a sit), the waist takes the pitch back out so the torso stays upright.

Paint channels are the beasts': coat is the animal, pale is the skin, points
the hair (and with it a horse's tail and lower legs, a lion's tail tuft).

Blender is Z-up; every creature faces -Y with its left side +X, like beasts.
"""

import json
import math
import importlib

import bpy
import bmesh
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
hold = B.hold_steps_


# ============================================================ solids, rescaled


def _pt(p, k):
    return tuple(float(x) * k for x in p)


def scale_solid(s, k):
    """A copy of one of beasts.py's solids, k times the size about the origin
    (which is the ground under the animal): its shape, its blend and the
    points its skin weights are graded between."""
    p = dict(s.p)
    if s.kind == "cone":
        p["a"], p["b"] = _pt(p["a"], k), _pt(p["b"], k)
        p["ra"], p["rb"] = p["ra"] * k, p["rb"] * k
    else:
        p["c"], p["r"] = _pt(p["c"], k), _pt(p["r"], k)
    bind = s.bind
    if isinstance(bind, tuple) and bind[0] == "chain":
        bind = ("chain", [(b, V(_pt(q, k))) for (b, q) in bind[1]])
    elif isinstance(bind, tuple):
        bind = (bind[0], bind[1], bind[2], V(_pt(bind[3], k)), V(_pt(bind[4], k)))
    squash = None if s.squash is None else list(s.squash)
    return B.Solid(s.kind, s.blend * k, bind, s.mask, neg=s.neg, squash=squash, group=s.group, **p)


def bones_of(bind):
    if isinstance(bind, str):
        return {bind}
    if isinstance(bind, dict):
        return set(bind)
    if bind[0] == "chain":
        return {b for (b, _) in bind[1]}
    return {bind[1], bind[2]}


def scale_landmarks(L, k):
    out = {}
    for key, val in L.items():
        if key in ("extra", "leg_squash"):
            continue
        if isinstance(val, (int, float)):
            out[key] = val * k
        elif isinstance(val, tuple) and val and isinstance(val[0], (int, float)):
            out[key] = _pt(val, k)
        else:
            out[key] = [_pt(p, k) for p in val]
    if "leg_squash" in L:
        out["leg_squash"] = L["leg_squash"]
    return out


HEAD_BONES = {"neck", "neck2", "neck3", "head", "jaw", "ear.L", "ear.R", "flop.L", "flop.R"}
HUMAN = ("waist", "torso", "neck", "head", "beard", "clavicle.L", "clavicle.R", "uarm.L", "uarm.R",
         "farm.L", "farm.R", "hand.L", "hand.R")


# ============================================================ the person's half

# A man and a woman, as the people are built (people.py MALE and FEMALE), in
# their own canon: (side, forward, up) metres with the feet at 0. `hip` is the
# height the animal's body takes over from; everything above it is the
# person's. Girths are people.py's at the waist and chest.
HUMAN_BODY = {
    "m": dict(hip=0.955, waist=1.08, chest=1.30, shoulder=(0.182, 1.43), neck_base=1.47, head_joint=1.60,
              crown=1.752, upper=0.292, fore=0.252, hand=0.185, chest_r=(0.165, 0.105, 0.13), waist_r=0.135,
              arm_r=(0.05, 0.039, 0.029, 0.026), neck_r=0.058),
    "f": dict(hip=0.905, waist=1.02, chest=1.22, shoulder=(0.160, 1.345), neck_base=1.382, head_joint=1.508,
              crown=1.650, upper=0.272, fore=0.232, hand=0.170, chest_r=(0.142, 0.092, 0.12), waist_r=0.112,
              arm_r=(0.043, 0.033, 0.025, 0.022), neck_r=0.047),
}


class Human:
    """Where the person's half stands on a taur: canon point -> Blender point."""

    def __init__(self, sex, fwd, junction):
        self.sex = sex
        self.D = HUMAN_BODY[sex]
        self.fwd = fwd
        self.dz = junction - self.D["hip"]

    def at(self, s, f, u):
        return P(s, self.fwd + f, u + self.dz)

    def shift(self):
        """From the people's world (heads.py, hair.py) to the taur's."""
        return V((0.0, -self.fwd, self.dz))

    def arm(self, side):
        D = self.D
        sx, sz = D["shoulder"]
        # Hung a little out from the sides and forward, elbow soft, so the
        # arm's own skin never touches the flank it would web into.
        pts = [(sx, 0.0, sz), (sx + 0.07, 0.01, sz - D["upper"]),
               (sx + 0.11, 0.06, sz - D["upper"] - D["fore"] * 0.98),
               (sx + 0.12, 0.08, sz - D["upper"] - D["fore"] - D["hand"] * 0.95)]
        return [self.at(*B.apply_side(p, side)) for p in pts]

    def bones(self, parent="chest"):
        D = self.D
        sx, sz = D["shoulder"]
        b = [("waist", self.at(0, 0.0, D["hip"] + 0.03), self.at(0, 0.0, D["waist"] + 0.04), parent),
             ("torso", self.at(0, 0.0, D["waist"] + 0.04), self.at(0, -0.005, sz), "waist"),
             ("neck", self.at(0, -0.005, D["neck_base"]), self.at(0, 0.0, D["head_joint"]), "torso"),
             ("head", self.at(0, 0.0, D["head_joint"]), self.at(0, 0.0, D["crown"]), "neck"),
             ("beard", self.at(0, 0.07, D["head_joint"] + 0.02), self.at(0, 0.09, D["head_joint"] - 0.06), "head")]
        for side, tag in ((1, ".L"), (-1, ".R")):
            a = self.arm(side)
            b += [("clavicle" + tag, self.at(side * 0.03, 0.0, sz - 0.01), a[0], "torso"),
                  ("uarm" + tag, a[0], a[1], "clavicle" + tag),
                  ("farm" + tag, a[1], a[2], "uarm" + tag),
                  ("hand" + tag, a[2], a[3], "farm" + tag)]
        return b

    def torso(self, blend_into="chest"):
        """The waist, chest, shoulders and neck, skin (the pale channel). The
        lowest solid is graded from the animal's chest to the waist so the
        two bodies are one surface where they meet."""
        D = self.D
        H = self.at
        skin = (1.0, 0.0)
        sx, sz = D["shoulder"]
        cw, cd, ch = D["chest_r"]
        wr = D["waist_r"]
        out = [
            ell(H(0, 0.0, D["hip"] + 0.02), (wr * 1.12, wr * 0.8, 0.12),
                ("grad", blend_into, "waist", H(0, 0, D["hip"] - 0.06), H(0, 0, D["hip"] + 0.1)), blend=0.09, mask=skin),
            cone(H(0, 0.005, D["hip"] + 0.05), H(0, 0.0, D["chest"] - 0.04), wr, cw * 0.92,
                 ("grad", "waist", "torso", H(0, 0, D["waist"] - 0.02), H(0, 0, D["chest"] - 0.04)), blend=0.06,
                 mask=skin, squash=(1, 0.72, 1)),
            ell(H(0, 0.0, D["chest"]), (cw, cd, ch), "torso", blend=0.05, mask=skin),
            ell(H(0, -0.03, D["chest"] - 0.02), (cw * 0.9, cd * 0.75, ch * 0.95), "torso", blend=0.05, mask=skin),
            ell(H(0, -0.005, sz - 0.005), (sx + 0.02, 0.07, 0.05), "torso", blend=0.05, mask=skin),
            cone(H(0, -0.005, sz - 0.02), H(0, 0.0, D["head_joint"] + 0.03), D["neck_r"], D["neck_r"] * 0.85,
                 ("grad", "torso", "neck", H(0, 0, D["neck_base"] - 0.02), H(0, 0, D["head_joint"])), blend=0.03,
                 mask=skin),
        ]
        if self.sex == "m":
            for side in (1, -1):
                out.append(ell(H(side * 0.075, 0.065, D["chest"] + 0.03), (0.078, 0.042, 0.058), "torso",
                               blend=0.03, mask=skin))
            out.append(ell(H(0, 0.06, D["waist"] + 0.02), (0.09, 0.04, 0.1), "waist", blend=0.04, mask=skin))
        else:
            for side in (1, -1):
                out.append(ell(H(side * 0.064, 0.072, D["chest"] - 0.005), (0.06, 0.055, 0.055), "torso",
                               blend=0.03, mask=skin))
        return out

    def arms(self):
        """The arms, their own mesh: shoulder cap, upper arm, forearm, hand."""
        D = self.D
        r0, r1, r2, r3 = D["arm_r"]
        skin = (1.0, 0.0)
        out = []
        for side, tag in ((1, ".L"), (-1, ".R")):
            a = self.arm(side)
            out += [ell(tuple(a[0]), (r0 * 1.12, r0 * 1.1, r0 * 1.2), ("grad", "torso", "uarm" + tag, a[0] + V((0, 0, 0.05)), a[0] - V((0, 0, 0.06))),
                        blend=0.03, mask=skin),
                    ell(tuple(a[0].lerp(a[1], 0.42)), (r0 * 1.1, r0 * 1.1, D["upper"] * 0.32), "uarm" + tag, blend=0.03, mask=skin),
                    cone(a[0], a[1], r0, r1, "uarm" + tag, blend=0.02, group="arm" + tag, mask=skin),
                    ell(tuple(a[1].lerp(a[2], 0.28)), (r1 * 1.15, r1 * 1.15, D["fore"] * 0.3), "farm" + tag, blend=0.025, mask=skin),
                    cone(a[1], a[2], r1, r2, "farm" + tag, blend=0.02, group="arm" + tag, mask=skin),
                    cone(a[2], a[3], r3 * 1.1, r3 * 0.85, "hand" + tag, blend=0.015, group="arm" + tag, mask=skin,
                         squash=(0.5, 1, 1))]
        return out

    def head(self, hair, beard=None, target=1500):
        """The face, eyes, brows, hair (and beard) from heads.py and hair.py,
        moved onto this body's neck. The face is the pale channel shaded by
        the sculpt's own cavities; hair and brows are the points."""
        import heads
        import hair as H_
        import people
        importlib.reload(heads)
        importlib.reload(H_)
        S = dict(heads.MALE if self.sex == "m" else heads.FEMALE, stubble=0.0)
        Pm = people.MALE if self.sex == "m" else people.FEMALE
        shift = mathutils.Matrix.Translation(self.shift())
        out = []
        face, field, _ = heads.build(S, Pm, "face", target=target)
        cols = np.array([d.color[:3] for d in face.data.color_attributes["Col"].data])
        lum = cols.mean(axis=1)
        lum = np.clip(lum / max(1e-6, float(np.percentile(lum, 95))), 0, 1)
        face.data.transform(shift)
        _rigid(face, "head")
        B.paint(face, np.stack([0.25 + 0.75 * lum ** 1.4, np.zeros(len(lum)), np.zeros(len(lum))], 1))
        lib.assign(face, "skin")
        out.append(face)
        for e in heads.eyes(S, Pm):
            e.data.transform(shift)
            _rigid(e, "head", keep_colour=True)
            out.append(e)
        for b in heads.brows(S, Pm, field):
            b.data.transform(shift)
            _rigid(b, "head")
            B.paint(b, np.tile(np.array([0.0, 1.0, 0.0]), (len(b.data.vertices), 1)))
            lib.assign(b, "fur")
            out.append(b)
        styles = {"long": lambda: H_.style_long(S, Pm, "hair", length=0.30),
                  "short": lambda: H_.style_short(S, Pm, "hair"),
                  "matted": lambda: H_.style_long(S, Pm, "hair", seed=41, length=0.36)}
        locks = styles[hair]()
        out.append(_hair_part(locks, shift, "head", 1500))
        if beard:
            out.append(_hair_part(H_.style_beard(S, Pm, "beard", beard), shift, "beard", 700))
        return out


def _rigid(obj, bone, keep_colour=False):
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    vg = obj.vertex_groups.new(name=bone)
    vg.add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    if not keep_colour:
        return obj
    # heads.py's eyes carry their iris and sclera in "Col" already, point
    # domain or not: write them back as the float point attribute the
    # exporter's ACTIVE colour reads.
    attr = obj.data.color_attributes.get("Col")
    if attr is not None and attr.domain == "POINT":
        cols = np.array([d.color[:3] for d in attr.data])
        B.paint(obj, cols)
    return obj


def _hair_part(obj, shift, bone, tris):
    """Hair from hair.py, onto the taur: moved, thinned, on one bone, and
    painted into the points channel by its own shading."""
    obj.data.transform(shift)
    B.decimate(obj, tris)
    col = obj.data.color_attributes.get("Col")
    shade = np.array([d.color[0] for d in col.data]) if col is not None and col.domain == "POINT" \
        else np.ones(len(obj.data.vertices))
    _rigid(obj, bone)
    B.paint(obj, np.stack([np.zeros(len(shade)), np.clip(0.35 + 0.65 * shade, 0, 1), np.zeros(len(shade))], 1))
    lib.assign(obj, "fur")
    return obj


def split_skin(body, threshold=0.5):
    """Cut one surface in two along its pale mask: the skin faces to their
    own object in `skin`, the rest staying in `fur`. The normals are fixed
    first as custom normals of the whole, so the cut does not show as a
    crease where the two are shaded apart."""
    me = body.data
    me.calc_loop_triangles()
    normals = [tuple(v.normal) for v in me.vertices]
    me.normals_split_custom_set_from_vertices(normals)
    col = me.color_attributes["Col"]
    pale = np.array([d.color[0] for d in col.data])
    skin = body.copy()
    skin.data = me.copy()
    skin.name = skin.data.name = "skin"
    bpy.context.collection.objects.link(skin)
    for obj, keep_skin in ((body, False), (skin, True)):
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        doomed = [f for f in bm.faces if (np.mean([pale[v.index] for v in f.verts]) > threshold) != keep_skin]
        bmesh.ops.delete(bm, geom=doomed, context="FACES")
        bm.to_mesh(obj.data)
        bm.free()
    lib.assign(skin, "skin")
    return body, skin


# ============================================================ the taur


def taur(name, lower, sex, extras=None):
    """One taur: `lower` is 'equine' or 'feline', `sex` 'm' or 'f'."""
    ex = extras or {}
    if lower == "equine":
        src = B.equine()
        # A horse a little under a riding horse's size -- 1.2 m at the
        # withers -- so that with a man's waist, chest and head on top the
        # whole is two metres and goes through a door with its head bowed.
        k, fwd, junction = 0.82, 0.56, 1.10
    else:
        src = B.feline()
        # A lion: the house cat at 3.6, which is the lion the viewer has.
        k, fwd, junction = 3.6, 0.5, 0.78
    L = scale_landmarks(src["L"], k)
    animal = [scale_solid(s, k) for s in src["body"] if not (bones_of(s.bind) & HEAD_BONES)]
    hu = Human(sex, fwd, junction)
    tail = L["tail"]
    body = animal + hu.torso()

    if lower == "equine":
        def masks(co, n, pale, dark):
            u = co[:, 2]
            f = -co[:, 1]
            low = np.clip((0.62 * k - u) / (0.14 * k), 0, 1) * (np.abs(f) > 0.3 * k) * (f < fwd - 0.12)
            return pale, np.maximum(dark, low)
        patch = B.spots(0.1, seed=29)
        legtop = L["hind"][1][2]
    else:
        def masks(co, n, pale, dark):
            f = -co[:, 1]
            u = co[:, 2]
            under = np.clip((-n[:, 2] - 0.1) / 0.5, 0, 1) * (u < 0.23 * k) * (f > -0.12 * k) * (f < 0.12 * k)
            return np.maximum(pale, under * 0.55), dark
        patch = lambda co: np.zeros(len(co))
        legtop = L["hind"][1][2]

    def parts(body_solids):
        out = []
        if lower == "equine":
            # The tail: a dock and a fall of hair, as the horse's.
            rng = np.random.default_rng(17)
            hair = [cone(P(*tail[i]), P(*tail[i + 1]), 0.06 * k, 0.055 * k, "tail%d" % (i + 1), blend=0.03 * k, group="d")
                    for i in range(2)]
            for j in range(8):
                a = 2 * math.pi * j / 8
                off = V((math.cos(a) * 0.04 * k, math.sin(a) * 0.03 * k, 0))
                pts = [V(tail[1]) + off * 0.5, V(tail[2]) + off * 1.3, V(tail[3]) + off * 1.9 + V((0, 0, rng.uniform(-0.03, 0.03) * k)),
                       V(tail[4]) + off * 2.4 + V((0, 0.02 * k * math.sin(a * 3), (-0.12 - rng.uniform(0, 0.12)) * k))]
                for i in range(3):
                    hair.append(cone(P(*pts[i]), P(*pts[i + 1]), (0.04 - 0.008 * i) * k, ((0.03 - 0.009 * i) if i < 2 else 0.006) * k,
                                     "tail%d" % (i + 2), blend=0.02 * k, squash=(0.6, 1, 1), group="t%d" % j))
            out.append(B.sdf_part(hair, 0.009 * k, 700, "tailhair", "fur", smooth=1,
                                  mask_fn=lambda co, n, p, d: (p * 0, np.ones(len(co)))))
            out += B.hooves(L, 0.006 * k, L["hoof"])
        else:
            # A lion's tuft at the end of the tail, dark.
            end = V(tail[-1])
            tuft = [ell(P(end.x, end.y - 0.02 * k, end.z - 0.004 * k), (0.016 * k, 0.03 * k, 0.016 * k),
                        "tail%d" % (len(tail) - 1), blend=0.01 * k)]
            out.append(B.sdf_part(tuft, 0.0025 * k, 160, "tuft", "fur", smooth=1,
                                  mask_fn=lambda co, n, p, d: (p * 0, np.ones(len(co)))))
            # Claws out of the forepaws, the curve of them.
            for side in (1, -1):
                t_ = ".L" if side > 0 else ".R"
                toe = V(B.apply_side(L["fore"][4], side))
                cl = [cone(P(toe.x + side * dx * k, toe.y + 0.004 * k, 0.006 * k),
                           P(toe.x + side * dx * k, toe.y + 0.014 * k, 0.001 * k), 0.0028 * k, 0.0008 * k,
                           "ftoe" + t_, blend=0.001 * k, group="c%d" % i) for i, dx in enumerate((-0.012, -0.004, 0.004, 0.012))]
                out.append(B.solid_part(cl, 0.0009 * k, 70, "claws", "horn", (0.75, 0.7, 0.6), smooth=0))
        out.append(B.sdf_part(hu.arms(), 0.006, 1300, "arms", "skin", smooth=1, patch_fn=lambda co: np.zeros(len(co))))
        out += hu.head(ex.get("hair", "short" if sex == "m" else "long"), beard=ex.get("beard"))
        if sex == "f":
            out.append(_top(hu, ex.get("top", "cloth"), ex.get("top_colour", (0.42, 0.14, 0.1))))
        return out

    bones = [b for b in B.quad_bones(dict(L, neck=[(0, 0.5 * k, 1.0 * k), (0, 0.6 * k, 1.1 * k)], nose=(0, 0.7 * k, 1.1 * k)))
             if b[0] not in HEAD_BONES] + hu.bones()
    g = dict(src["gait"])
    for key in ("walk_stride", "run_stride", "lift", "run_lift", "lie"):
        g[key] = g[key] * k
    if "loaf" in g and "lie" in g["loaf"]:
        g["loaf"] = dict(g["loaf"], lie=g["loaf"]["lie"] * k)
    g.pop("graze", None)
    g.update(ex.get("gait", {}))
    return dict(name=name, archetype="taur", lower=lower, sex=sex, L=L, body=body, masks=masks, parts=parts,
                patch=patch, h=min(src["h"] * k, 0.01), tris=ex.get("tris", 4400),
                bones=bones, gait=g, legtop=legtop, human=hu, clips=taur_clips, upper=ex.get("upper", "centaur"))


def _top(hu, mat, colour):
    """What a taur woman wears over her breasts: a band of cloth (a lamia's
    of beaten gold) wrapped round the chest, just off the skin."""
    D = hu.D
    H = hu.at
    cw, cd, ch = D["chest_r"]
    z = D["chest"]
    solids = [ell(H(0, 0.0, z), (cw * 1.14, cd * 1.22, ch * 1.05), "torso", blend=0.02)]
    for side in (1, -1):
        solids.append(ell(H(side * 0.064, 0.078, z - 0.005), (0.072, 0.066, 0.066), "torso", blend=0.03))
    # Cut to a band: everything above the top edge and below the bottom one away.
    solids.append(ell(H(0, 0.0, z + 0.585), (0.5, 0.5, 0.5), "torso", blend=0.012, neg=True))
    solids.append(ell(H(0, 0.0, z - 0.63), (0.5, 0.5, 0.5), "torso", blend=0.012, neg=True))
    return B.solid_part(solids, 0.004, 900, "top", mat, colour, smooth=1)


# ============================================================ taur clips


def _x_angle(rot):
    """Degrees of a body pitch about world X, or 0 for any other turn."""
    if rot is None:
        return 0.0
    q = rot.normalized()
    if abs(q.y) > 1e-4 or abs(q.z) > 1e-4:
        return 0.0
    return math.degrees(2.0 * math.atan2(q.x, q.w))


def arm_pose(fk, side, pitch=0.0, out=8.0, elbow=30.0, twist=0.0, wrist=-6.0):
    """One arm: `pitch` negative raises it forward, `out` takes it away from
    the side, `elbow` bends the forearm forward, `twist` turns it about its
    own length (the thumb out). Mirrored for the right."""
    tag = ".L" if side > 0 else ".R"
    fk["uarm" + tag] = (pitch, -side * out, side * twist)
    fk["farm" + tag] = (-elbow, 0, side * twist * 0.5)
    fk["hand" + tag] = (wrist, 0, 0)


# Arm poses with a place to be -- folded across the chest, a hand shading
# the eyes -- solved on the rig before the clips are keyed (`solve_arms`):
# guessed angles put a folded forearm through the face. Filled per build.
ARM_POSES = {}


def solved(fk, name, k=1.0, side=None):
    """Lay a solved arm pose over fk at weight k (from whatever it holds)."""
    for bone, a in ARM_POSES[name].items():
        if side is not None and not bone.endswith(".L" if side > 0 else ".R"):
            continue
        was = fk.get(bone, (0.0, 0.0, 0.0))
        fk[bone] = tuple(lerp(w, x, k) for w, x in zip(was, a))


def folded(fk, k=1.0):
    """Arms folded across the chest."""
    solved(fk, "folded", k)


def solve_arms(arm, hu):
    """Find uarm/farm angles (pitch, out, elbow, twist) that put the elbow
    and the hand tip where a pose wants them, by coordinate descent on the
    rig itself. Targets are in the person's canon (side, forward, up)."""
    D = hu.D
    c, sx, sz = D["chest"], D["shoulder"][0], D["shoulder"][1]
    poser = B.Poser(arm, B.quad_legs())
    wants = {
        # Forearms across the body under the chest, the left over the right.
        "folded": {1: ((sx + 0.02, 0.07, c - 0.13), (-0.12, 0.17, c - 0.08)),
                   -1: ((-sx - 0.02, 0.09, c - 0.17), (0.11, 0.19, c - 0.13))},
        # The right hand's edge at the brow, the elbow out and up.
        "shade": {-1: ((-sx - 0.13, 0.12, sz - 0.04), (0.02, 0.2, D["head_joint"] + 0.12))},
        # Hands on the hips, elbows out.
        "akimbo": {1: ((sx + 0.17, -0.04, c - 0.14), (0.12, 0.05, D["hip"] + 0.12)),
                   -1: ((-sx - 0.17, -0.04, c - 0.14), (-0.12, 0.05, D["hip"] + 0.12))},
    }
    for name, sides in wants.items():
        out = {}
        for side, (elbow, tip) in sides.items():
            tag = ".L" if side > 0 else ".R"
            te, th = V(hu.at(*elbow)), V(hu.at(*tip))

            def cost(p):
                fk = {}
                arm_pose(fk, side, pitch=p[0], out=p[1], elbow=p[2], twist=p[3], wrist=0)
                poser.solve(fk)
                e = poser.world_of("uarm" + tag)
                h = poser.world_of("hand" + tag)
                # A little for bending further than an elbow goes.
                return (e - te).length_squared + (h - th).length_squared + 1e-6 * max(0.0, p[2] - 150) ** 2
            p = [-20.0, 0.0, 60.0, 0.0]
            best = cost(p)
            step = 32.0
            while step > 0.25:
                moved = False
                for i in range(4):
                    for d in (step, -step):
                        q = list(p)
                        q[i] += d
                        c_ = cost(q)
                        if c_ < best:
                            p, best, moved = q, c_, True
                if not moved:
                    step *= 0.5
            fk = {}
            arm_pose(fk, side, pitch=p[0], out=p[1], elbow=p[2], twist=p[3], wrist=0)
            out.update(fk)
            print("arm pose %s%s: pitch %.0f out %.0f elbow %.0f twist %.0f, miss %.3f m" % (
                name, tag, p[0], p[1], p[2], p[3], math.sqrt(best)))
        ARM_POSES[name] = out


def upper_pose(kind, name, t, pose):
    """The person's half of a taur, for a clip of the animal's: waist,
    torso, neck, head and the arms, as fk."""
    fk = {}
    tilt = _x_angle(pose.get("rot"))
    # A body pitched by a pastime (the rear, a sit) has its torso put back
    # upright by the waist, most of the way.
    level = -tilt * 0.85
    lamia = kind == "lamia"

    def trunk(lean=0.0, turn=0.0, side=0.0, nod=0.0, look=0.0):
        fk["waist"] = (level + lean * 0.5, side * 0.5, turn * 0.5)
        fk["torso"] = (lean * 0.5, side * 0.5, turn * 0.5)
        fk["neck"] = (nod * 0.4, 0, look * 0.4)
        fk["head"] = (nod * 0.6, 0, look * 0.6)

    if name == "idle":
        breath = wave(3 * t)
        look = hold(t, [(0.08, 28.0), (0.34, -22.0), (0.6, 8.0), (0.84, 0.0)])
        trunk(lean=1.5 * breath, turn=look * 0.15, nod=2 * wave(t, 0.3) - 2, look=look * 0.85)
        if lamia:
            # One hand on her hip, the other hanging easy.
            arm_pose(fk, -1, pitch=-2 + 2 * breath, out=5, elbow=16, wrist=2)
            solved(fk, "akimbo", 1.0, side=1)
        else:
            arm_pose(fk, 1, pitch=-2 + 2 * breath, out=4, elbow=10, wrist=4)
            arm_pose(fk, -1, pitch=-1 + 2 * breath, out=5, elbow=16, wrist=2)
    elif name in ("walk", "run"):
        run = name == "run"
        swing = (9 if not run else 26) * wave(t, 0.25)
        trunk(lean=(4 + 3 * wave(2 * t, 0.2)) if not run else (14 + 4 * wave(t, 0.3)), turn=-4 * wave(t, 0.25),
              nod=-2 if not run else -10, look=0)
        arm_pose(fk, 1, pitch=(-2 if not run else -10) + swing, out=6, elbow=(14 if not run else 80) - 6 * wave(t, 0.25), wrist=0)
        arm_pose(fk, -1, pitch=(-2 if not run else -10) - swing, out=6, elbow=(14 if not run else 80) + 6 * wave(t, 0.25), wrist=0)
    elif name == "attack":
        cock = ease(t / 0.36) * (1 - ease((t - 0.4) / 0.1))
        strike = ease((t - 0.4) / 0.1) * (1 - ease((t - 0.62) / 0.38))
        if lamia:
            # Both hands up, then raking down at the face in front of her.
            trunk(lean=-8 * cock + 22 * strike, nod=-6 * cock + 10 * strike)
            for s_ in (1, -1):
                arm_pose(fk, s_, pitch=-130 * cock - 70 * strike + (1 - cock - strike) * -10, out=22 * cock + 10 * strike,
                         elbow=40 * cock + 20 * strike + 30 * (1 - cock - strike), wrist=-30 * strike)
        else:
            # A right-handed blow: wound back over the shoulder, then driven
            # forward and down with the turn of the torso behind it.
            trunk(lean=-6 * cock + 16 * strike, turn=-26 * cock + 30 * strike, nod=-4 * cock + 8 * strike)
            arm_pose(fk, -1, pitch=lerp(-8, 25, cock) - 95 * strike, out=lerp(10, 35, cock) - 10 * strike,
                     elbow=lerp(30, 115, cock) - 95 * strike)
            arm_pose(fk, 1, pitch=-35 * max(cock, strike) - 6, out=10, elbow=lerp(30, 100, max(cock, strike)))
    elif name == "hit":
        k = math.sin(math.pi * min(1.0, t / 0.35)) if t < 0.35 else (1 - ease((t - 0.35) / 0.65)) * 0.8
        trunk(lean=-14 * k, turn=10 * k, nod=-16 * k, look=12 * k)
        arm_pose(fk, 1, pitch=-45 * k - 6, out=18 * k + 8, elbow=30 + 70 * k)
        arm_pose(fk, -1, pitch=-30 * k - 6, out=22 * k + 8, elbow=30 + 60 * k)
    elif name == "death":
        settle = ease((t - 0.25) / 0.6)
        buckle = ease(t / 0.3)
        trunk(lean=-10 * buckle + 40 * settle, side=-25 * settle, nod=30 * settle, look=-20 * settle)
        arm_pose(fk, 1, pitch=-10 * buckle + 15 * settle, out=10 + 35 * settle, elbow=30 - 20 * settle)
        arm_pose(fk, -1, pitch=-30 * buckle - 30 * settle, out=10 + 25 * settle, elbow=30 - 15 * settle)
    elif name == "doze":
        breath = wave(2 * t)
        trunk(lean=4 + 1.2 * breath, nod=22 + 4 * wave(t, 0.2))
        folded(fk)
    elif name == "alert":
        k = ease(t / 0.1) * (1 - ease((t - 0.82) / 0.18))
        trunk(lean=-4 * k, turn=14 * k, nod=-6 * k, look=26 * k)
        # A hand up to shade the eyes, looking off.
        arm_pose(fk, -1, pitch=-2, out=5, elbow=16, wrist=2)
        solved(fk, "shade", k, side=-1)
        arm_pose(fk, 1, pitch=-2, out=5, elbow=10, wrist=4)
        solved(fk, "akimbo", k, side=1)
    elif name == "rear":
        k = ease(t / 0.25) * (1 - ease((t - 0.78) / 0.22))
        roar = ease((t - 0.35) / 0.08) * (1 - ease((t - 0.62) / 0.1))
        trunk(lean=-6 * k, nod=-12 * k - 8 * roar)
        for s_ in (1, -1):
            arm_pose(fk, s_, pitch=lerp(-6, -150, k) + 20 * roar * s_, out=lerp(10, 30, k), elbow=lerp(30, 25, k))
    elif name == "loaf":
        breath = wave(2 * t)
        look = hold(t, [(0.08, 20.0), (0.3, -16.0), (0.66, 6.0), (0.9, 0.0)])
        trunk(lean=2 + breath, look=look, nod=4)
        if lamia:
            arm_pose(fk, 1, pitch=-40, out=6, elbow=60, wrist=-25)
            arm_pose(fk, -1, pitch=-36, out=8, elbow=64, wrist=-25)
        else:
            folded(fk)
    elif name == "haunch":
        breath = wave(3 * t)
        look = hold(t, [(0.12, 22.0), (0.45, -18.0), (0.75, 0.0)])
        trunk(lean=breath, look=look, turn=look * 0.2)
        arm_pose(fk, 1, pitch=-22, out=6, elbow=70, wrist=-30)
        arm_pose(fk, -1, pitch=-20, out=8, elbow=72, wrist=-30)
    elif name == "stretch":
        k = ease(t / 0.3) * (1 - ease((t - 0.7) / 0.3))
        trunk(lean=-14 * k, nod=-18 * k)
        for s_ in (1, -1):
            arm_pose(fk, s_, pitch=-165 * k - 6 * (1 - k), out=12 + 6 * k, elbow=30 * (1 - k) + 6 * k)
    else:
        trunk()
        arm_pose(fk, 1)
        arm_pose(fk, -1)
    return fk


class TaurClip(B.Clip):
    """beasts.Clip, with the person's half laid over every pose the animal's
    clip function makes. Swapped in for beasts.Clip while quad_clips runs."""
    kind = "centaur"

    def run(self, name, frames, fn, track=None, step=1):
        kind = TaurClip.kind

        def wrapped(t):
            pose = fn(t)
            fk = {k: v for k, v in pose.get("fk", {}).items() if k not in HUMAN}
            fk.update(upper_pose(kind, name, t, pose))
            pose["fk"] = fk
            return pose
        return super().run(name, frames, wrapped, track=track, step=step)


def taur_clips(arm, spec):
    TaurClip.kind = spec["upper"]
    solve_arms(arm, spec["human"])
    saved = B.Clip
    B.Clip = TaurClip
    try:
        report = B.quad_clips(arm, spec)
    finally:
        B.Clip = saved
    extra = B.Clip(B.Poser(arm, B.quad_legs()))
    poser = extra.poser
    rest = B.leg_rest(poser)
    height = rest["fore.L"]["hip"].z
    tails = sorted([b.name for b in arm.data.bones if b.name.startswith("tail")], key=lambda n: int(n[4:]))
    names = spec["gait"].get("extra", [])

    if "paw" in names:
        # A hoof pawing at the ground, three scrapes, the arms folded and the
        # head down to watch it: impatience, or a horse's way of asking.
        def paw(t):
            k = ease(t / 0.12) * (1 - ease((t - 0.85) / 0.15))
            fk = {}
            fk.update(B.tail_wave(tails, t, 6 + 10 * k, freq=2, pitch=spec["gait"].get("tail_pitch", 0.0)))
            hu = {}
            scrape = sum(math.exp(-((t - c) * 14) ** 2) for c in (0.3, 0.48, 0.66)) * k
            drag = sum(max(0.0, min(1.0, (t - c + 0.07) / 0.14)) * math.exp(-((t - c) * 9) ** 2) for c in (0.3, 0.48, 0.66))
            ik = {leg: B.planted(rest, leg) for leg in rest}
            ik["fore.R"] = B.planted(rest, "fore.R", fwd=height * (0.14 * scrape - 0.12 * drag * k), up=height * 0.13 * scrape,
                                     meta=40 * scrape, toe=30 * scrape)
            hu["waist"] = (3 * k, 0, 0)
            hu["torso"] = (4 * k, 0, -6 * k)
            hu["neck"] = (12 * k, 0, -8 * k)
            hu["head"] = (16 * k, 0, -10 * k)
            folded(hu)
            fk.update(hu)
            return dict(fk=fk, loc=V((0, 0, 0)), ik=ik)
        extra.run("paw", 120, paw)

    if "beckon" in names:
        # The lamia that is 'waiting for her next meal': she looks you over,
        # tilts her head, and crooks a finger -- come here.
        def beckon(t):
            k = ease(t / 0.15) * (1 - ease((t - 0.85) / 0.15))
            crook = (0.5 + 0.5 * wave(3 * t)) * ease((t - 0.25) / 0.1) * (1 - ease((t - 0.8) / 0.1))
            hu = {}
            hu["waist"] = (2 * k, 4 * k, 6 * k)
            hu["torso"] = (2 * k, 4 * k, 4 * k)
            hu["neck"] = (-4 * k, 8 * k, 0)
            hu["head"] = (-6 * k, 10 * k, 0)
            arm_pose(hu, -1, pitch=lerp(-14, -62, k), out=lerp(6, 14, k), elbow=lerp(60, 40, k) + 55 * crook,
                     twist=-60 * k, wrist=-20 - 40 * crook)
            arm_pose(hu, 1, pitch=-18, out=4, elbow=55, wrist=-20)
            fk = dict(hu)
            fk.update(B.tail_wave(tails, t, 10, freq=2, pitch=spec["gait"].get("tail_pitch", 0.0)))
            ik = {leg: B.planted(rest, leg) for leg in rest}
            return dict(fk=fk, loc=V((0, 0, 0)), ik=ik)
        extra.run("beckon", 120, beckon)

    report["clips"].update(extra.report)
    return report


# ============================================================ assets


def centaur():
    """'The upper torso of a man and lower body of a horse': a bay horse's
    body at 1.2 m to the withers and a man to the waist rising from in front
    of them -- two metres in all. The elders and the chief are this with a
    beard (`hide` takes it off the young ones)."""
    return taur("beast_centaur", "equine", "m", dict(
        beard="full", tris=4400,
        gait=dict(pastimes=["doze", "alert", "rear", "loaf"], extra=["paw"],
                  loaf=dict(hind=(-55, 130, -95, 10), fore=(30, -80, 160, 20), lie=0.5, neck=0, head=0,
                            tail=[(-25, 10), (0, 15), (0, 15), (0, 15), (0, 10)]),
                  rear_pitch=40.0)))


def centaur_f():
    """'The upper torso of a woman and lower body of a horse'."""
    return taur("beast_centaur_f", "equine", "f", dict(
        hair="long", top="cloth", top_colour=(0.34, 0.2, 0.1), tris=4400,
        gait=dict(pastimes=["doze", "alert", "rear", "loaf"], extra=["paw"],
                  loaf=dict(hind=(-55, 130, -95, 10), fore=(30, -80, 160, 20), lie=0.5, neck=0, head=0,
                            tail=[(-25, 10), (0, 15), (0, 15), (0, 15), (0, 10)]),
                  rear_pitch=40.0)))


def lamia():
    """'A creature with the upper torso of a beautiful woman, but the lower
    body of a four-legged beast': a lioness's body, a woman from the waist,
    long dark hair and a band of gold."""
    return taur("beast_lamia", "feline", "f", dict(
        hair="long", top="gold", top_colour=(1.0, 1.0, 1.0), tris=4200, upper="lamia",
        gait=dict(pastimes=["haunch", "loaf", "stretch"], extra=["beckon"], tail_pitch=-26.0)))


# ============================================================ the harpy


HARPY_HIP = 0.80
HARPY_LEG = [(0.10, 0.0, 0.78), (0.125, 0.13, 0.50), (0.11, -0.07, 0.21), (0.11, 0.0, 0.035), (0.11, 0.13, 0.0)]


def harpy():
    """Dylan's harpies: 'the screaming, filthy harpy claws madly at your
    face ... her entire body is caked in filth and grime ... her razor-sharp
    talons flex', and the leader 'stretches her wings and you see insects
    crawling around them. Her hair is matted and greasy.' A woman to the
    hips -- face, long matted hair, arms -- on a vulture's feathered thighs
    and bare scaled legs with hooked talons, and her arms are wings: long
    feathers grow from the back of each arm and run out past the hand, so
    folded they hang behind her like a ragged cloak and spread they are a
    wing. A metre and a half to the crown.

    Coat is the feathers, pale the skin, points the hair and the dark ends
    of the flight feathers; the patch is grime, laid on the skin and the
    feathers alike."""
    hu = Human("f", 0.0, HARPY_HIP)
    D = hu.D
    feather = (0.0, 0.0)
    legs = HARPY_LEG
    body = hu.torso(blend_into="pelvis") + [
        # Feathered hips and belly up to the navel, and the thighs in their
        # 'trousers' of feathers down to the knee.
        ell(P(0, -0.015, HARPY_HIP + 0.02), (0.17, 0.14, 0.13), "pelvis", blend=0.06, mask=feather),
        ell(P(0, 0.02, HARPY_HIP + 0.1), (0.135, 0.1, 0.08), ("grad", "pelvis", "waist", P(0, 0, HARPY_HIP), P(0, 0, HARPY_HIP + 0.15)),
            blend=0.05, mask=feather),
    ]
    for side, tag in ((1, ".L"), (-1, ".R")):
        q = [V(B.apply_side(p, side)) for p in legs]
        body += [ell(P(*q[0].lerp(q[1], 0.45)), (0.085, 0.1, 0.16), "thigh" + tag, blend=0.05, mask=feather),
                 cone(P(*q[1]), P(*q[1].lerp(q[2], 0.55)), 0.07, 0.04, "shin" + tag, blend=0.04, mask=feather)]
    bones = [("pelvis", P(0, 0, HARPY_HIP - 0.07), P(0, 0, HARPY_HIP + 0.03), None),
             ("tail1", P(0, -0.08, HARPY_HIP - 0.02), P(0, -0.34, HARPY_HIP - 0.24), "pelvis")]
    bones += hu.bones(parent="pelvis")
    for side, tag in ((1, ".L"), (-1, ".R")):
        q = [B.apply_side(p, side) for p in legs]
        par = "pelvis"
        for i, n in enumerate(B.LEG_BONES["hind"]):
            bones.append((n + tag, P(*q[i]), P(*q[i + 1]), par))
            par = n + tag

    def masks(co, n, pale, dark):
        return pale, dark

    def grime(co):
        return np.clip(B.patch_noise(co, cell=0.07, seed=53) * 1.2 - 0.1, 0, 1)

    def wing(side):
        """Feathers off the back of one arm, from the shoulder to past the
        hand: a thin vane, broad at the elbow, the flight feathers fanned
        at its end. Graded along the arm's bones so it folds with them."""
        tag = ".L" if side > 0 else ".R"
        a = hu.arm(side)
        back = V((0, 1, 0))        # Blender +Y is behind her
        tip = a[3] + (a[3] - a[2]).normalized() * 0.42
        sq = (0.16, 1, 1)
        g = lambda p, q, b1, b2: ("grad", b1, b2, p, q)
        out = [
            cone(a[0] + back * 0.06, a[1] + back * 0.2, 0.07, 0.13, g(a[0], a[1], "uarm" + tag, "farm" + tag), blend=0.03,
                 squash=sq, mask=(0, 0.1)),
            cone(a[1] + back * 0.2, a[2] + back * 0.24, 0.13, 0.13, g(a[1], a[2], "farm" + tag, "hand" + tag), blend=0.03,
                 squash=sq, mask=(0, 0.25)),
        ]
        # The primaries: separate long feathers fanning out past the hand.
        for i, k in enumerate((0.0, 0.25, 0.5, 0.75, 1.0)):
            root = a[2].lerp(a[3], 0.4) + back * (0.03 + 0.17 * k)
            end = tip + back * (0.06 + 0.36 * k) + V((side * 0.01 * i, 0, 0.1 * k))
            out.append(cone(root, end, 0.05 - 0.005 * i, 0.012, "hand" + tag, blend=0.012, squash=sq,
                            mask=(0, 0.75), group="p%d" % i))
        return out

    def parts(body_solids):
        out = []
        for side in (1, -1):
            out.append(B.sdf_part(wing(side), 0.006, 900, "wing", "feather", smooth=1, patch_fn=grime))
        out.append(B.sdf_part(hu.arms(), 0.006, 1100, "arms", "skin", smooth=1, patch_fn=grime))
        out += hu.head("matted")
        # The tail: a short fan of dark feathers.
        tail = [cone(P(x, -0.08, HARPY_HIP - 0.02), P(x * 2.2, -0.36, HARPY_HIP - 0.22), 0.05, 0.035, "tail1", blend=0.02,
                     squash=(1, 1, 0.25), mask=(0, 0.5), group="f%d" % i) for i, x in enumerate((-0.05, 0.0, 0.05))]
        out.append(B.sdf_part(tail, 0.005, 400, "tail", "feather", smooth=1, patch_fn=grime))
        # Bare scaled legs and feet: three toes forward and one back, every
        # one ending in a hooked black talon.
        for side, tag in ((1, ".L"), (-1, ".R")):
            q = [V(B.apply_side(p, side)) for p in legs]
            knee, ankle, foot = q[1], q[2], q[3]
            r = 0.024
            sol = [cone(P(*knee.lerp(ankle, 0.5)), P(*ankle), r * 1.2, r, "shin" + tag, blend=r, group="l"),
                   cone(P(*ankle), P(*foot), r, r * 0.85, "hock" + tag, blend=r, group="l")]
            claws = []
            for k_, (ang, ln) in enumerate(((0.0, 0.15), (32.0, 0.12), (-32.0, 0.12), (180.0, 0.08))):
                a_ = math.radians(ang) * side
                end = V((foot.x + math.sin(a_) * ln, foot.y + math.cos(a_) * ln, 0.012))
                bone = "htoe" + tag
                sol.append(cone(P(*foot), P(*end), r * 0.75, r * 0.45, bone, blend=r * 0.5, group="t%d" % k_))
                d = (end - foot).normalized()
                claws.append(cone(P(*end), P(*(end + d * 0.035 + V((0, 0, -0.012)))), r * 0.42, 0.002, bone, blend=0.002,
                                  group="c%d" % k_))
            out.append(B.solid_part(sol, 0.004, 700, "leg", "horn", (0.42, 0.36, 0.2)))
            out.append(B.solid_part(claws, 0.0015, 220, "talons", "horn", (0.035, 0.03, 0.03), smooth=0))
        return out

    return dict(name="beast_harpy", archetype="harpy", body=body, masks=masks, parts=parts, patch=grime,
                h=0.008, tris=3600, mat="feather", bones=bones, legtop=HARPY_HIP - 0.25, human=hu,
                clips=harpy_clips, split="feather",
                gait=dict(walk_stride=0.62, walk_frames=24, run_stride=1.3, run_frames=18))


def harpy_clips(arm, spec):
    """idle (hunched, the head snapping from one thing to the next like a
    bird's), walk and run in two-footed hops, attack (a leap with the
    talons thrown forward and the wings beating), hit, death, and the
    pastimes: perch, preen, flap and the shriek."""
    g = spec["gait"]
    poser = B.Poser(arm, M.BIPED_LEGS)
    rest = B.leg_rest(poser)
    clip = B.Clip(poser)
    hip = poser.rest["pelvis"].translation.z
    report = {}

    def wings(fk, spread=0.0, beat=0.0, fold=1.0):
        """Folded: arms hanging back and bent, the feathers a cloak behind.
        Spread: out level, elbows straight; `beat` raises (+) or lowers."""
        for s_ in (1, -1):
            arm_pose(fk, s_, pitch=lerp(14, -10, spread), out=lerp(6, 84 + beat, spread),
                     elbow=lerp(34 * fold, 6, spread), twist=lerp(0, -20, spread), wrist=0)

    def trunk(fk, hunch=14.0, turn=0.0, nod=0.0, look=0.0, side=0.0):
        fk["waist"] = (hunch * 0.5, side * 0.5, turn * 0.5)
        fk["torso"] = (hunch * 0.5, side * 0.5, turn * 0.5)
        fk["neck"] = (-hunch * 0.4 + nod * 0.4, 0, look * 0.4)
        fk["head"] = (-hunch * 0.4 + nod * 0.6, 0, look * 0.6)

    def snap_look(t, amp=35.0):
        return hold(t, [(0.1, amp), (0.28, -amp * 0.6), (0.46, amp * 0.3), (0.63, -amp), (0.82, 0.0)], snap=0.03)

    crouch_meta = 12.0

    def idle(t):
        breath = wave(3 * t)
        fk = {"pelvis": (0, 0, 1.5 * wave(t)), "tail1": (6 * wave(2 * t), 0, 0)}
        trunk(fk, hunch=16 + breath, look=snap_look(t), nod=4 * wave(2 * t, 0.3))
        wings(fk, spread=0.04 + 0.03 * breath)
        ik = {leg: B.planted(rest, leg, meta=crouch_meta) for leg in rest}
        return dict(fk=fk, loc=V((0, 0, -hip * 0.05 + hip * 0.004 * breath)), ik=ik)
    clip.run("idle", 120, idle, step=2)

    def hop(t, S, flaps):
        """Two hops a cycle. On the ground the feet stand still on it --
        sliding back under the body at the travel speed -- while it crouches
        and springs; in the air they swing forward for the landing."""
        p = (2 * t) % 1.0
        ground = 0.5
        a = S / 8.0                  # each stance slides the feet S/4 back
        if p < ground:
            x = p / ground
            fwd = a - 2 * a * x
            lift = 0.0
            crouch = math.sin(math.pi * x)
            feet = 0.0
        else:
            x = (p - ground) / (1 - ground)
            fwd = -a + 2 * a * ease(x)
            lift = 4 * x * (1 - x) * S * 0.28
            crouch = 0.0
            feet = lift * 0.8
        ik = {leg: B.planted(rest, leg, fwd=fwd, up=feet, meta=crouch_meta + 25 * crouch - 10 * (feet > 0),
                             toe=30 * (feet > 0)) for leg in rest}
        fk = {"tail1": (-14 * lift / max(1e-6, S * 0.28), 0, 0)}
        trunk(fk, hunch=18 + 10 * crouch, nod=-6 * math.sin(2 * math.pi * p))
        beat = 40 * math.sin(2 * math.pi * p) if flaps else 0.0
        wings(fk, spread=(0.55 + 0.25 * math.sin(math.pi * p)) if flaps else 0.12 + 0.1 * crouch, beat=beat)
        return dict(fk=fk, loc=V((0, 0, lift - hip * (0.05 + 0.12 * crouch))), ik=ik)
    S, N = g["walk_stride"], g["walk_frames"]
    track = {leg: poser.legs[leg]["chain"][3] for leg in poser.legs}
    tracks = clip.run("walk", N, lambda t: hop(t, S, False), track=track)
    S2, N2 = g["run_stride"], g["run_frames"]
    clip.run("run", N2, lambda t: hop(t, S2, True))

    def hover_fly(t):
        beat = math.sin(2 * math.pi * t)
        fk = {"tail1": (-20, 0, 0)}
        trunk(fk, hunch=-6, nod=6)
        wings(fk, spread=1.0, beat=45 * beat)
        ik = {leg: B.planted(rest, leg, fwd=0.12, up=0.35 + 0.05 * beat, meta=60, toe=80) for leg in rest}
        return dict(fk=fk, loc=V((0, 0, 0.45 + 0.06 * math.sin(2 * math.pi * t - 0.8))), ik=ik)
    clip.run("fly", 14, hover_fly)

    HIT = 0.5

    def attack(t):
        # Up off the ground on a beat of the wings, the talons swung forward
        # at the face, raking at the hit frame, and down again.
        up = ease(t / 0.35) * (1 - ease((t - 0.62) / 0.38))
        rake = math.exp(-((t - HIT) * 9) ** 2)
        beat = math.sin(2 * math.pi * 2 * t)
        fk = {"tail1": (-25 * up, 0, 0)}
        trunk(fk, hunch=16 - 30 * up, nod=10 * up)
        wings(fk, spread=0.15 + 0.85 * up, beat=50 * beat * up)
        ik = {leg: B.planted(rest, leg, fwd=0.32 * up + 0.12 * rake, up=0.42 * up + 0.08 * rake, meta=crouch_meta + 55 * up,
                             toe=-30 * rake + 20 * up) for leg in rest}
        return dict(fk=fk, loc=V((0, -0.25 * up, 0.5 * up - hip * 0.05 * (1 - up))), ik=ik)
    clip.run("attack", 24, attack)
    report["hit"] = HIT

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.3)) if t < 0.3 else (1 - ease((t - 0.3) / 0.7)) * 0.8
        fk = {"tail1": (10 * k, 0, 0)}
        trunk(fk, hunch=16 - 22 * k, nod=-14 * k, look=18 * k)
        wings(fk, spread=0.5 * k, beat=-10 * k)
        ik = {leg: B.planted(rest, leg, meta=crouch_meta) for leg in rest}
        return dict(fk=fk, loc=V((0, hip * 0.1 * k, -hip * 0.05)), ik=ik)
    clip.run("hit", 12, hit)

    def death(t):
        buckle = ease(t / 0.3)
        fall = ease((t - 0.15) / 0.5)
        fk = {"tail1": (-10 * fall, 0, 0)}
        trunk(fk, hunch=16 - 30 * fall, nod=-20 * fall, look=30 * fall)
        wings(fk, spread=0.7 * fall, beat=-20 * fall)
        for tag in (".L", ".R"):
            fk["thigh" + tag] = (-40 * buckle, 0, 0)
            fk["shin" + tag] = (70 * buckle, 0, 0)
            fk["hock" + tag] = (-50, 0, 0)
            fk["htoe" + tag] = (60 * fall, 0, 0)
        rot = mathutils.Quaternion(V((1, 0, 0)), math.radians(-85 * fall))
        loc = V((0, 0, lerp(0.0, -(hip - 0.16), fall) - hip * 0.25 * buckle * (1 - fall)))
        return dict(fk=fk, loc=loc, rot=rot, ik={leg: B.planted(rest, leg) for leg in rest}, limp=ease((t - 0.1) / 0.3))
    clip.run("death", 40, death)

    # -- perch: down on her heels, wings wrapped round, head low and still,
    # the eyes going.
    def perch(t):
        fk = {"tail1": (8, 0, 0)}
        trunk(fk, hunch=34, nod=-10 + 4 * wave(t, 0.2), look=snap_look(t, 20.0) * 0.6)
        for s_ in (1, -1):
            arm_pose(fk, s_, pitch=-8, out=-2, elbow=60, twist=10, wrist=0)
        ik = {leg: B.planted(rest, leg, fwd=-0.02, meta=55) for leg in rest}
        return dict(fk=fk, loc=V((0, 0.03, -hip * 0.3)), ik=ik)
    clip.run("perch", 120, perch, step=2)

    # -- preen: the head turned down into one wing, picking at it.
    def preen(t):
        k = ease(t / 0.15) * (1 - ease((t - 0.85) / 0.15))
        pick = max(0.0, wave(5 * t)) * k
        fk = {"tail1": (4 * k, 0, 0)}
        trunk(fk, hunch=16 + 10 * k, turn=-14 * k, look=-55 * k, nod=24 * k + 6 * pick, side=-6 * k)
        wings(fk, spread=0.04)
        arm_pose(fk, 1, pitch=lerp(14, -30, k), out=lerp(6, 42, k), elbow=lerp(34, 50, k), twist=-30 * k)
        ik = {leg: B.planted(rest, leg, meta=crouch_meta) for leg in rest}
        return dict(fk=fk, loc=V((0, 0, -hip * 0.05)), ik=ik)
    clip.run("preen", 90, preen)

    # -- flap: wings thrown open and beaten, a hop up off the ground.
    def flap(t):
        k = ease(t / 0.12) * (1 - ease((t - 0.82) / 0.18))
        beat = math.sin(2 * math.pi * 4 * t)
        fk = {"tail1": (-14 * k, 0, 0)}
        trunk(fk, hunch=16 - 10 * k, nod=-6 * k)
        wings(fk, spread=k, beat=40 * beat * k)
        hop_ = max(0.0, beat) * 0.08 * k
        ik = {leg: B.planted(rest, leg, up=hop_, meta=crouch_meta) for leg in rest}
        return dict(fk=fk, loc=V((0, 0, hop_ - hip * 0.05)), ik=ik)
    clip.run("flap", 45, flap)

    # -- shriek: what the 'screaming' harpies do at whoever comes near --
    # crouched, wings flared high, the head thrust out at you.
    def shriek(t):
        k = ease(t / 0.1) * (1 - ease((t - 0.8) / 0.2))
        cry = ease((t - 0.15) / 0.06) * (1 - ease((t - 0.7) / 0.1))
        fk = {"tail1": (-18 * k, 0, 0)}
        trunk(fk, hunch=16 + 14 * k, nod=-30 * k + 6 * wave(7 * t) * cry)
        fk["neck"] = (fk["neck"][0] + 6 * cry, 0, 0)
        wings(fk, spread=0.85 * k, beat=30 * k + 8 * wave(6 * t) * cry)
        ik = {leg: B.planted(rest, leg, meta=crouch_meta + 20 * k) for leg in rest}
        return dict(fk=fk, loc=V((0, -0.08 * cry, -hip * (0.05 + 0.08 * k))), ik=ik)
    clip.run("shriek", 60, shriek)

    report["clips"] = clip.report
    report["stride"] = {"walk": S, "run": S2}
    report["walk"] = hop_slip(tracks, S, N)
    report["overreach"] = clip.reach
    return report


def hop_slip(tracks, stride, frames):
    """Largest slide of a planted toe over the ground in a two-footed hop:
    the first half of each hop is stance."""
    worst = 0.0
    for leg, pts in tracks.items():
        anchor = None
        for i, p in enumerate(pts):
            t = i / frames
            on = ((2 * t) % 1.0) < 0.5 - 1e-6
            world = V((p.x, p.y - stride * t, p.z))
            if on:
                anchor = anchor or world
                worst = max(worst, (world - anchor).length)
            else:
                anchor = None
    return worst


# ============================================================ the golem


class Box(B.Solid):
    """A rounded box, for things that were cut or cast rather than grown:
    centre c, half-extents h, corner radius r, turned by rot (degrees)."""

    def __init__(self, c, h, r, bind, blend=0.02, mask=(0, 0), rot=None, group=None):
        m = None
        if rot:
            R = mathutils.Euler([math.radians(x) for x in rot]).to_matrix()
            m = np.array([list(R.col[0]), list(R.col[1]), list(R.col[2])]).T
        super().__init__("box", blend, bind, mask, group=group, c=tuple(c), h=tuple(h), r=r, m=m)

    def bounds(self):
        c = np.array(self.p["c"])
        e = float(np.linalg.norm(self.p["h"])) + self.p["r"]
        pad = self.blend + 0.01
        return c - e - pad, c + e + pad

    def dist(self, q):
        p = self.p
        local = q - np.array(p["c"])
        if p["m"] is not None:
            local = local @ p["m"]
        d = np.abs(local) - (np.array(p["h"]) - p["r"])
        out = np.linalg.norm(np.maximum(d, 0.0), axis=1) + np.minimum(d.max(axis=1), 0.0)
        return out - p["r"]


def box_between(a, b, w, d, bind, r=0.03, blend=0.015, mask=(0, 0), group=None):
    """A box along a limb from a to b (Blender points), w wide and d deep."""
    a, b = V(a), V(b)
    axis = (b - a)
    L = axis.length
    q = axis.to_track_quat("Z", "Y")
    e = q.to_euler()
    return Box(tuple((a + b) * 0.5), (w, d, L * 0.5 + r), r, bind, blend=blend, mask=mask,
               rot=tuple(math.degrees(x) for x in e), group=group)


def golem():
    """A golem: 'a big chunk of rock that has been magically formed into a
    giant stone creature', 'like a statue, until you see it shamble towards
    you'. Two and a quarter metres of blocks fitted together -- a chest
    like a lintel, shoulders like boulders, a small head sunk between them
    with two lit slits for eyes, fists the size of a man's head, legs like
    pillars -- with the joints left showing as joints. Built once; the
    viewer makes it of stone, granite, clay, bronze, iron, wood, flesh,
    rags or crystal by the surface it wears (BEASTS `surface`)."""
    hip = 1.0
    L = dict(spine=[(0, 0, hip), (0, 0, 1.25), (0, 0.02, 1.5)], neck=[(0, 0.05, 1.74), (0, 0.08, 1.84)],
             crown=(0, 0.08, 2.08), clavicle=(0.1, 0.02, 1.7),
             arm=[(0.44, 0.0, 1.68), (0.52, 0.02, 1.27), (0.54, 0.1, 0.9), (0.54, 0.15, 0.7)],
             leg=[(0.17, 0, hip - 0.02), (0.19, 0.06, 0.56), (0.19, -0.02, 0.15), (0.19, 0.12, 0.05), (0.19, 0.26, 0.0)])
    bind = lambda a, b, pa, pb: ("grad", a, b, P(*pa), P(*pb))
    body = [
        Box(P(0, 0, hip + 0.02), (0.27, 0.18, 0.15), 0.05, "pelvis", blend=0.02),
        Box(P(0, 0.0, 1.27), (0.24, 0.16, 0.13), 0.05, bind("pelvis", "spine", (0, 0, 1.1), (0, 0, 1.35)), blend=0.03),
        Box(P(0, 0.02, 1.56), (0.38, 0.23, 0.2), 0.07, "chest", blend=0.03, rot=(6, 0, 0)),
        ell(P(0, -0.08, 1.66), (0.3, 0.16, 0.14), "chest", blend=0.06),
        Box(P(0, 0.08, 1.86), (0.12, 0.13, 0.13), 0.04, "head", blend=0.02),
        # A brow like a beam over the eyes, and a jaw like a step.
        Box(P(0, 0.17, 1.92), (0.135, 0.04, 0.03), 0.015, "head", blend=0.01),
        Box(P(0, 0.15, 1.77), (0.1, 0.05, 0.04), 0.02, "head", blend=0.012),
        Box(P(0, 0.05, 1.76), (0.09, 0.08, 0.05), 0.03, bind("chest", "head", (0, 0, 1.7), (0, 0, 1.82)), blend=0.03),
    ]
    for side, tag in ((1, ".L"), (-1, ".R")):
        a = [B.apply_side(p, side) for p in L["arm"]]
        q = [B.apply_side(p, side) for p in L["leg"]]
        body += [
            ell(P(*B.apply_side((0.43, 0.0, 1.73), side)), (0.19, 0.19, 0.17), "uarm" + tag, blend=0.025),
            box_between(P(*a[0]), P(*a[1]), 0.12, 0.13, "uarm" + tag, blend=0.012, group="a" + tag),
            box_between(P(*a[1]), P(*a[2]), 0.14, 0.15, "farm" + tag, blend=0.012, group="b" + tag),
            Box(P(*a[3]), (0.11, 0.12, 0.13), 0.04, "hand" + tag, blend=0.015),
            ell(P(*a[1]), (0.11, 0.11, 0.1), ("grad", "uarm" + tag, "farm" + tag, P(*a[1]) + V((0, 0, 0.05)), P(*a[1]) - V((0, 0, 0.05))), blend=0.01),
            box_between(P(*q[0]), P(*q[1]), 0.15, 0.16, "thigh" + tag, blend=0.012, group="c" + tag),
            box_between(P(*q[1]), P(*q[2]), 0.13, 0.14, "shin" + tag, blend=0.012, group="d" + tag),
            ell(P(*q[1]), (0.12, 0.12, 0.1), ("grad", "thigh" + tag, "shin" + tag, P(*q[1]) + V((0, 0, 0.05)), P(*q[1]) - V((0, 0, 0.05))), blend=0.01),
            Box(P(q[3][0], 0.09, 0.075), (0.13, 0.19, 0.075), 0.03, "hock" + tag, blend=0.012),
        ]

    def masks(co, n, pale, dark):
        # Darker in the joints and the undersides, where a statue's grime
        # gathers: the points channel.
        under = np.clip((-n[:, 2] - 0.2) / 0.6, 0, 1)
        return pale, np.maximum(dark, under * 0.6)

    def parts(body_solids):
        out = []
        for side in (1, -1):
            at = B.surface_point(body_solids, P(side * 0.055, 0.5, 1.865), P(0, -1, 0), sink=0.012)
            out.append(B.solid_part([Box(tuple(at), (0.03, 0.012, 0.009), 0.004, "head", blend=0.002)], 0.003, 60,
                                    "eye", "glow", (1.0, 1.0, 1.0), smooth=0))
        return out

    return dict(name="beast_golem", archetype="golem", bones=M.biped_bones(L), body=body, masks=masks, parts=parts,
                patch=B.spots(0.09, seed=61), h=0.014, tris=3600, mat="hide", clips=golem_clips, legtop=99.0,
                gait=dict(walk_stride=0.95, walk_frames=44, lift=0.07, run_stride=1.5, run_frames=30))


def golem_clips(arm, spec):
    """A golem has no breath to take: its idle is stillness, with the head
    turning now and then in a grinding stop-start. It walks with the whole
    weight on each foot in turn, the body rolling over it, and strikes with
    both fists from overhead. It dies by toppling forward."""
    g = spec["gait"]
    poser = B.Poser(arm, M.BIPED_LEGS)
    rest = B.leg_rest(poser)
    clip = B.Clip(poser)
    hip = poser.rest["pelvis"].translation.z
    offsets = {"hind.L": 0.0, "hind.R": 0.5}
    flex = {"hind": dict(lean=6, push=12, fold=35, curl=20)}
    report = {}

    def arms(fk, swing=0.0, out=10.0, elbow=18.0, raise_=0.0):
        for tag, s in ((".L", 1), (".R", -1)):
            fk["uarm" + tag] = (swing * s - raise_, 0, -s * out)
            fk["farm" + tag] = (-elbow - raise_ * 0.2, 0, 0)
            fk["hand" + tag] = (0, 0, 0)

    def grind(t):
        # Held still, turning in short stiff jerks with a pause between.
        return hold(t, [(0.15, 22.0), (0.2, 26.0), (0.55, -14.0), (0.6, -18.0), (0.85, 0.0)], snap=0.06)

    def idle(t):
        look = grind(t)
        fk = {"chest": (2, look * 0.15, 0), "neck": (0, 0, 0), "head": (-2, 0, look * 0.8)}
        arms(fk)
        return dict(fk=fk, loc=V((0, 0, 0)), ik={leg: B.planted(rest, leg) for leg in rest})
    clip.run("idle", 120, idle, step=2)

    def stomp(t, S, duty, lift, run):
        ik, _ = B.gait_targets(rest, t, S, duty, lift, offsets, flex)
        sway = wave(t, 0.25)
        # The weight comes down on each foot: a drop and a jar at the strike.
        jar = sum(math.exp(-((((t - c) % 1.0) - 0.0) * 30) ** 2) for c in (0.0, 0.5))
        fk = {"pelvis": (0, 0, 5 * sway), "spine": (3 if run else 1, 0, -3 * sway), "chest": (4 if run else 2, -4 * wave(t), -2 * sway),
              "neck": (0, 0, 0), "head": (2 * jar, 0, 3 * sway)}
        arms(fk, swing=(10 if not run else 18) * wave(t), out=12, elbow=20 if not run else 40)
        loc = V((0.05 * sway, 0, -hip * (0.025 + 0.02 * jar) - (0.04 * hip if run else 0)))
        return dict(fk=fk, loc=loc, ik=ik)
    S, N = g["walk_stride"], g["walk_frames"]
    track = {leg: poser.legs[leg]["chain"][3] for leg in poser.legs}
    tracks = clip.run("walk", N, lambda t: stomp(t, S, 0.7, g["lift"], False), track=track)
    report["walk"] = B.foot_slip(tracks, S, N, 0.7, offsets)
    S2, N2 = g["run_stride"], g["run_frames"]
    tracks = clip.run("run", N2, lambda t: stomp(t, S2, 0.55, g["lift"] * 1.4, True), track=track)
    report["run"] = B.foot_slip(tracks, S2, N2, 0.55, offsets)

    HIT = 0.55

    def attack(t):
        up = ease(t / 0.42) * (1 - ease((t - 0.46) / 0.1))
        down = ease((t - 0.46) / 0.09) * (1 - ease((t - 0.7) / 0.3))
        fk = {"spine": (-8 * up + 18 * down, 0, 0), "chest": (-10 * up + 16 * down, 0, 0), "neck": (0, 0, 0),
              "head": (8 * up - 10 * down, 0, 0)}
        arms(fk, out=8 - 6 * up, elbow=lerp(18, 60, up) - 40 * down, raise_=170 * up + 70 * down * (1 - up))
        loc = V((0, -hip * 0.12 * down, -hip * 0.06 * down))
        return dict(fk=fk, loc=loc, ik={leg: B.planted(rest, leg) for leg in rest})
    clip.run("attack", 36, attack)
    report["hit"] = HIT

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.3)) if t < 0.3 else (1 - ease((t - 0.3) / 0.7)) * 0.8
        fk = {"spine": (-5 * k, 0, 0), "chest": (-4 * k, 3 * k, 0), "neck": (0, 0, 0), "head": (-6 * k, 0, 10 * k)}
        arms(fk, swing=-8 * k, out=10 + 6 * k)
        return dict(fk=fk, loc=V((0, hip * 0.04 * k, 0)), ik={leg: B.planted(rest, leg) for leg in rest})
    clip.run("hit", 12, hit)

    def death(t):
        buckle = ease(t / 0.35)
        fall = ease((t - 0.25) / 0.45) ** 1.6
        fk = {"spine": (8 * buckle, 0, 0), "chest": (6 * buckle, 0, 0), "neck": (0, 0, 0), "head": (10 * fall, 0, 0)}
        arms(fk, swing=-20 * fall, out=10 + 30 * fall, elbow=10)
        for tag in (".L", ".R"):
            fk["thigh" + tag] = (-25 * buckle, 0, 0)
            fk["shin" + tag] = (40 * buckle, 0, 0)
        rot = mathutils.Quaternion(V((1, 0, 0)), math.radians(86 * fall))
        loc = V((0, -hip * 0.4 * fall, lerp(0.0, -(hip - 0.27), fall) - hip * 0.15 * buckle * (1 - fall)))
        return dict(fk=fk, loc=loc, rot=rot, ik={leg: B.planted(rest, leg) for leg in rest}, limp=ease((t - 0.15) / 0.3))
    clip.run("death", 40, death)

    # -- wake: what a golem 'standing guard' does when you come close: the
    # head comes round and down to you, the fists close and lift a little,
    # and it settles back. Nothing else stirs.
    def wake(t):
        k = ease(t / 0.15) * (1 - ease((t - 0.8) / 0.2))
        fk = {"chest": (4 * k, 0, 0), "neck": (6 * k, 0, 0), "head": (6 * k, 0, 0)}
        arms(fk, swing=-14 * k, out=14, elbow=18 + 40 * k)
        return dict(fk=fk, loc=V((0, 0, -hip * 0.03 * k)), ik={leg: B.planted(rest, leg) for leg in rest})
    clip.run("wake", 60, wake)

    report["clips"] = clip.report
    report["stride"] = {"walk": S, "run": S2}
    report["overreach"] = clip.reach
    return report


# ============================================================ the goat


def goat():
    """The fire newts' mountain goats, ewes and kids, 'black': the deer's
    frame (beasts.cervid) made a goat -- a deeper, broader barrel on the
    same fine legs, horns that sweep up and back off the poll in place of
    antlers, a beard off the chin, a shaggy coat. The kid is this at half
    the size with the horns and the beard taken off (`hide`)."""
    spec = B.cervid()
    L = spec["L"]
    extra = dict(L["extra"])
    extra.pop("antler*")
    extra["horn*"] = ((0.03, 0.55, 1.1), (0.07, 0.42, 1.24), "head")
    extra["beard"] = ((0, 0.66, 0.9), (0, 0.65, 0.8), "jaw")
    L = dict(L, extra=extra)
    body = list(spec["body"])
    barrel = body[0]
    body[0] = B.Solid(barrel.kind, barrel.blend, barrel.bind, barrel.mask, c=barrel.p["c"],
                      r=(barrel.p["r"][0] * 1.22, barrel.p["r"][1], barrel.p["r"][2] * 1.1), m=barrel.p.get("m"))
    old_parts = spec["parts"]

    def parts(body_solids):
        out = []
        for o in old_parts(body_solids):
            if o.name.startswith("antler"):
                bpy.data.objects.remove(o, do_unlink=True)
            else:
                out.append(o)
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            x = side
            pts = [(x * 0.03, 0.56, 1.09), (x * 0.045, 0.53, 1.17), (x * 0.065, 0.47, 1.22), (x * 0.08, 0.4, 1.21),
                   (x * 0.085, 0.36, 1.16)]
            horn = [cone(P(*pts[i]), P(*pts[i + 1]), 0.017 - i * 0.0035, 0.0145 - i * 0.0035, "horn" + t, blend=0.004,
                         group="h") for i in range(4)]
            out.append(B.solid_part(horn, 0.0025, 260, "horn", "horn", (0.16, 0.14, 0.12)))
        beard = [cone(P(0, 0.665, 0.905), P(0, 0.655, 0.8), 0.022, 0.006, "beard", blend=0.01, squash=(0.7, 1, 1))]
        out.append(B.sdf_part(beard, 0.004, 160, "beard", "fur", smooth=1,
                              mask_fn=lambda co, n, p, d: (p * 0, np.ones(len(co)) * 0.7)))
        return out

    g = dict(spec["gait"])
    g["pastimes"] = ["alert", "loaf"]
    g["loaf"] = dict(lie=0.2, neck=-10, head=10)
    return dict(spec, name="beast_goat", archetype="caprine", L=L, body=body, parts=parts,
                patch=B.spots(0.03, seed=71), gait=g, clips=B.quad_clips, legtop=L["hind"][1][2])


# ============================================================ the fire newt


def newt():
    """The fire newts: a people -- workers 'hot and sweaty', guards,
    mothers, a priest, a general -- and, by their name, newts. A newt that
    walks: upright on bent legs, the body leaning forward over them and
    balanced by a long flat tail on the ground behind, a broad flat head
    with a wide lipless mouth and small high eyes, smooth wet skin, four
    fingers. They were trolls, tusks and hair and all. Coat is the back
    (fire red), pale the belly (yellow), the patch the dark spots."""
    hip = 0.74
    L = dict(spine=[(0, -0.02, hip), (0, 0.04, 0.98), (0, 0.12, 1.2)], neck=[(0, 0.18, 1.3), (0, 0.24, 1.36)],
             crown=(0, 0.48, 1.38), jaw=[(0, 0.26, 1.33), (0, 0.45, 1.31)], clavicle=(0.06, 0.13, 1.25),
             arm=[(0.19, 0.13, 1.23), (0.25, 0.14, 0.99), (0.24, 0.32, 0.9), (0.24, 0.41, 0.86)],
             leg=[(0.12, -0.02, hip - 0.04), (0.15, 0.16, 0.44), (0.14, -0.04, 0.15), (0.14, 0.05, 0.03), (0.14, 0.16, 0.0)],
             tail=[(0, -0.12, 0.7), (0, -0.34, 0.5), (0, -0.56, 0.26), (0, -0.8, 0.08), (0, -1.06, 0.03), (0, -1.32, 0.03)])
    body = [
        ell(P(0, 0.0, 0.82), (0.18, 0.15, 0.19), ("grad", "pelvis", "spine", P(0, 0, 0.72), P(0, 0.04, 1.0)), blend=0.08),
        ell(P(0, 0.08, 1.07), (0.19, 0.15, 0.19), ("grad", "spine", "chest", P(0, 0.04, 0.98), P(0, 0.12, 1.2)), blend=0.08),
        ell(P(0, 0.13, 1.22), (0.17, 0.12, 0.1), "chest", blend=0.06),
        cone(P(0, 0.15, 1.24), P(0, 0.25, 1.36), 0.11, 0.1, ("grad", "chest", "neck", P(0, 0.15, 1.26), P(0, 0.22, 1.35)), blend=0.05),
        # A broad, flat head, wider than it is deep, the snout rounded.
        ell(P(0, 0.32, 1.39), (0.135, 0.15, 0.08), "head", blend=0.04),
        ell(P(0, 0.43, 1.37), (0.11, 0.085, 0.055), "head", blend=0.03),
        ell(P(0, 0.09, 1.02), (0.15, 0.11, 0.15), "spine", blend=0.06, mask=(0.9, 0)),
        ell(P(0, 0.06, 0.82), (0.14, 0.12, 0.12), "pelvis", blend=0.06, mask=(0.8, 0)),
    ]
    body += M.biped_limbs(L, [0.055, 0.042, 0.034, 0.028], [0.1, 0.065, 0.045, 0.04, 0.03], 0.04)
    tail = L["tail"]
    for i in range(len(tail) - 1):
        body.append(cone(P(*tail[i]), P(*tail[i + 1]), 0.11 - i * 0.02, 0.095 - i * 0.02, "tail%d" % (i + 1), blend=0.03,
                         group="tail", squash=(0.75, 1, 1)))
    for side, tag in ((1, ".L"), (-1, ".R")):
        body.append(ell(P(side * 0.12, 0.03, 0.6), (0.085, 0.12, 0.15), "thigh" + tag, blend=0.06))

    def masks(co, n, pale, dark):
        under = np.clip((-n[:, 1] - 0.2) / 0.5, 0, 1) * (co[:, 2] > 0.55) * (co[:, 2] < 1.3)
        return np.maximum(pale * 0.6, under), dark

    def parts(body_solids):
        out = []
        jaw = [cone(P(0, 0.27, 1.335), P(0, 0.47, 1.32), 0.085, 0.05, "jaw", blend=0.015, squash=(1.2, 1, 0.45))]
        out.append(B.sdf_part(jaw, 0.004, 220, "jaw", "hide", smooth=1, mask_fn=lambda co, n, p, d: (np.maximum(p, 0.8), d)))
        for side in (1, -1):
            at = B.surface_point(body_solids, P(side * 0.07, 0.36, 1.5), P(0, 0, -1), sink=0.01)
            out.append(B.solid_part([ell(tuple(at), (0.018, 0.02, 0.016), "head", blend=0.003)], 0.0025, 80, "eye", "horn",
                                    (0.6, 0.42, 0.04), smooth=0))
            # Four blunt fingers.
            h = [V(B.apply_side(p, side)) for p in L["arm"]]
            tag = ".L" if side > 0 else ".R"
            fingers = [cone(P(h[3].x + side * 0.014 * (k - 1.5), h[3].y - 0.01, h[3].z + 0.01),
                            P(h[3].x + side * 0.02 * (k - 1.5), h[3].y + 0.05, h[3].z - 0.03), 0.011, 0.008, "hand" + tag,
                            blend=0.004, group="f%d" % k) for k in range(4)]
            out.append(B.sdf_part(fingers, 0.003, 200, "fingers", "hide", smooth=1))
        return out

    return dict(name="beast_newt", archetype="newt", bones=M.biped_bones(L), body=body, masks=masks, parts=parts,
                patch=B.spots(0.045, seed=13), h=0.011, tris=3400, mat="hide", clips=M.biped_clips, legtop=99.0,
                gait=dict(walk_stride=0.7, walk_frames=28, lift=0.07, run_stride=1.3, run_frames=18, hunch=16.0, lie=0.16,
                          pastimes=["sniff"]))


SPECS = [centaur, centaur_f, lamia, harpy, golem, goat, newt]


def build_one(spec, export=True):
    lib.reset()
    bpy.context.scene.render.fps = FPS
    body = B.sdf_part(spec["body"], spec["h"], spec["tris"], "body", spec.get("mat", "fur"),
                      smooth=spec.get("smooth", 2), mask_fn=spec.get("masks"), patch_fn=spec.get("patch"))
    parts = [body]
    if spec.get("archetype") == "taur" or spec.get("split"):
        fur, skin = split_skin(body)
        parts = [fur, skin]
    parts += spec["parts"](spec["body"])
    arm = M.make_rig(spec["name"], spec.get("bones") or B.quad_bones(spec["L"]))
    meshes = B.bind(arm, parts, spec["name"], legtop=spec.get("legtop"))
    tris = lib.stats(meshes)
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


# ============================================================ looking at it

COATED = ("MAT:fur", "MAT:feather", "MAT:scales", "MAT:chitin", "MAT:ooze", "MAT:hide", "MAT:skin")


def preview_materials(coat, pale, dark, patch=None, threshold=0.55, flat=None):
    """The viewer's paint, roughly: coated tags mix coat/pale/points by the
    masks; the rest show their vertex colour (times `flat[tag]` if given)."""
    flat = flat or {}
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
            bsdf.inputs["Roughness"].default_value = 0.7 if mat.name == "MAT:skin" else 0.9
        else:
            tint = flat.get(mat.name[4:])
            if tint:
                m = nt.nodes.new("ShaderNodeMix")
                m.data_type = "RGBA"
                m.blend_type = "MULTIPLY"
                m.inputs[0].default_value = 1.0
                nt.links.new(attr.outputs["Color"], m.inputs[6])
                m.inputs[7].default_value = tuple(tint) + (1,)
                nt.links.new(m.outputs[2], bsdf.inputs["Base Color"])
            else:
                nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
            bsdf.inputs["Roughness"].default_value = 0.3
            if mat.name in ("MAT:gold", "MAT:brass", "MAT:iron", "MAT:steel"):
                bsdf.inputs["Metallic"].default_value = 0.85


def sheet(make, path, shots, coat=(0.36, 0.22, 0.12), pale=(0.78, 0.6, 0.48), dark=(0.08, 0.06, 0.05),
          patch=None, flat=None, size=(520, 520), built=None, zoom=None):
    """Render `shots` [(clip, frame, azim, elev)] of one creature to PNGs
    `path`-N.png, framed on its bounds, for montage and judging by eye."""
    if built is None:
        built = build_one(make(), export=False)
    arm, meshes, tris, rep = built
    preview_materials(coat, pale, dark, patch, flat=flat or {"gold": (1.0, 0.75, 0.35), "cloth": (1, 1, 1)})
    out = []
    for i, (clip, frame, azim, elev) in enumerate(shots):
        if clip == "rest":
            arm.animation_data.action = None
            for pb in arm.pose.bones:
                pb.rotation_mode = "QUATERNION"
                pb.rotation_quaternion = (1, 0, 0, 0)
                pb.location = (0, 0, 0)
        else:
            arm.animation_data.action = bpy.data.actions[clip]
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        pts = []
        for m in meshes:
            ev = m.evaluated_get(dg)
            me = ev.to_mesh()
            pts += [ev.matrix_world @ me.vertices[i].co for i in range(0, len(me.vertices), 7)]
            ev.to_mesh_clear()
        lo = V((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = V((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        size_ = (hi - lo).length
        tgt = (lo + hi) * 0.5
        if zoom:
            # Close on the head bone.
            hb = arm.pose.bones["head"]
            tgt = arm.matrix_world @ hb.head.lerp(hb.tail, 0.4)
            size_ = zoom
        p = "%s-%02d.png" % (path, i)
        B.render(p, target=tuple(tgt), dist=size_ * 1.45, azim=azim, elev=elev, size=size)
        out.append(p)
    return out, tris, rep
