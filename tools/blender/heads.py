"""heads -- faces, sculpted as signed distance fields.

The head this replaces was a stack of horizontal rings with the features laid
on as displacements, and a nose, lips, eyes and brows stuck on as separate
solids. At three metres it read as a clay head: every feature had a seam
round it where it met the face, the rings ran straight through the eye
sockets and the corners of the mouth, and the female head was the male one
scaled down.

Here the head is modelled the way a sculptor blocks one in -- cranium,
frontal bone, brow ridge, cheekbones, the maxilla and the dental arch, the
jaw, the chin, the nose in three masses, two lips -- as a signed distance
field in which every part is smoothly unioned into every other, so there are
no seams to see: a brow runs into the nose, a cheekbone into the temple, the
jaw into the neck. The eyelids are part of the same field: a shell round the
eyeball with an almond cut out of it, so the lid has a margin and a thickness
and the eyeball behind it is a separate glossy mesh that can turn.

The field is then turned into a mesh by casting a ray in from outside along
every direction of a dense icosphere and stopping at the first surface; the
mesh is decimated (quadric, symmetric) to its budget, the vertices are put
back onto the surface, and every normal is the field's own gradient -- so
shading is as smooth as the field, whatever the triangulation, which is what
makes the skin read as skin and not as a lump of decimated clay.

What a face needs in colour it gets in vertex colour: the field's own
ambient occlusion (sockets, nostrils, the corners of the mouth, under the
jaw), lips, a flush on the cheeks, nose and ears, the lash line, and a
shaved man's beard shadow. The per-person skin tint multiplies over it.

Coordinates are a man's head's metres about the eye line (people.head_center),
x to the figure's left, y back, z up -- Blender's axes, with the face at -y.
A person's head table (P["head"]) scales them.
"""

import math

import numpy as np
import bpy
import bmesh
from mathutils import Vector

import lib

V = Vector


# --- the field -------------------------------------------------------------

def _len(v):
    return np.sqrt((v * v).sum(-1))


def ell(p, c, r):
    """Ellipsoid, the usual bound-preserving approximation."""
    c = np.asarray(c, float)
    r = np.asarray(r, float)
    q = (p - c) / r
    k0 = _len(q)
    k1 = _len(q / r)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def seg(p, a, b, r1, r2=None):
    """A capsule from a to b, its radius running r1 to r2."""
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    r2 = r1 if r2 is None else r2
    pa = p - a
    ba = b - a
    h = np.clip((pa @ ba) / (ba @ ba), 0.0, 1.0)
    return _len(pa - h[:, None] * ba) - (r1 + (r2 - r1) * h)


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b + (a - b) * h - k * h * (1.0 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def g(u, s):
    return np.exp(-(u / s) ** 2)


# Faces, as parameters. MALE is an adult man; the others are read off it.
#
# The mass of the head is a loft: a section every so often from the crown to
# the chin, each a superellipse in front (n = 2 is an ellipse, 3 a rounded
# box, which is what the front of a face is: flat across the cheeks and
# turning sharply at the sides) and an ellipse behind. W is the half-width,
# F how far forward the face is on the midline without the nose and lips,
# B how far back the skull or the neck is. Read off anthropometric means for
# a man -- head breadth 152 mm, bizygomatic 140, bigonial 110, nasion to
# menton 122 -- and then set by eye against the renders.
LOFT_MALE = [
    # z       W       F       B      n
    (0.092, 0.059, 0.070, 0.091, 2.2),
    (0.075, 0.068, 0.082, 0.100, 2.4),
    (0.055, 0.073, 0.089, 0.104, 2.6),
    (0.035, 0.074, 0.092, 0.106, 2.8),
    (0.018, 0.071, 0.089, 0.105, 3.0),
    (0.000, 0.070, 0.079, 0.102, 3.2),
    (-0.018, 0.071, 0.078, 0.097, 3.2),
    (-0.036, 0.068, 0.080, 0.090, 2.8),
    (-0.054, 0.065, 0.083, 0.080, 2.3),
    (-0.070, 0.062, 0.082, 0.068, 2.2),
    (-0.082, 0.059, 0.079, 0.060, 2.3),
    (-0.094, 0.051, 0.084, 0.056, 2.5),
    (-0.105, 0.038, 0.083, 0.052, 2.4),
    (-0.113, 0.023, 0.076, 0.046, 2.2),
    (-0.119, 0.008, 0.064, 0.040, 2.0),
]


def _loft_scale(table, zk=1.0, wk=(), fk=(), bk=(), nk=()):
    """A table altered piecewise: each of wk/fk/bk/nk is [(z, factor)],
    interpolated over the rows."""
    def at(pairs, z):
        if isinstance(pairs, float):
            return pairs
        if not pairs:
            return 1.0
        return float(np.interp(z, [a for a, _ in pairs], [b for _, b in pairs]))
    return [(z * at(zk, z), w * at(wk, z), f * at(fk, z), b * at(bk, z), n * at(nk, z))
            for (z, w, f, b, n) in table]


MALE = dict(
    name="male", sex="m",
    loft=LOFT_MALE,
    # The crown: an ellipsoid fitted to the loft's top row, which closes it
    # round where a quarter-ellipse of the rows made a flat lid.
    dome=((0.0, 0.012, 0.062), (0.069, 0.094, 0.058)),
    brow=1.0,                     # the supraorbital ridge
    cheek=((0.050, -0.060, -0.014), (0.016, 0.013, 0.010)),
    chin=((0.0, -0.078, -0.100), (0.016, 0.010, 0.012)),
    mouth_z=-0.0635, mouth_y=-0.0900,
    neck_r=0.048,
    eye=(0.0315, -0.067, 0.004), eye_r=0.0120,
    fissure=(0.0148, 0.0043, 0.0042),   # half-width, upper and lower opening
    lid=0.0017,                    # lid thickness over the eyeball
    tilt=0.0010,                   # the outer corner higher than the inner
    nose=1.0, nose_w=1.0, nose_len=1.0,
    nose_top=0.012, nose_up=0.0,
    apple=None, fold_z=0.0030,
    lips=1.0, lip_w=1.0,
    fold=0.4,                      # nasolabial fold, 0..1
    age=0.0,                       # 0 young adult .. 1 old
    stubble=1.0,
)

# A woman's head is not a man's scaled down: the brow is smooth and the
# forehead rounder and more upright, the jaw narrower and its angle softer,
# the chin smaller and pointed, the eyes a little larger in the face, the
# nose smaller and the lips fuller.
FEMALE = dict(
    MALE, name="female", sex="f",
    loft=_loft_scale(LOFT_MALE, zk=[(0.13, 1.0), (-0.03, 1.0), (-0.13, 0.97)],
                     wk=[(0.10, 1.0), (0.03, 1.0), (0.0, 0.975), (-0.03, 0.955), (-0.06, 0.945), (-0.09, 0.945), (-0.105, 0.99), (-0.12, 1.04)],
                     fk=[(0.10, 1.02), (0.04, 0.985), (0.02, 0.96), (0.0, 0.985), (-0.07, 0.985), (-0.10, 0.97)],
                     bk=[(0.1, 1.0), (-0.06, 0.96), (-0.12, 0.92)],
                     nk=[(0.1, 0.94), (0.03, 0.88), (0.0, 0.80), (-0.05, 0.80), (-0.09, 0.84), (-0.12, 0.90)]),
    brow=0.15,
    cheek=((0.047, -0.055, -0.010), (0.018, 0.014, 0.012)),
    chin=((0.0, -0.074, -0.098), (0.011, 0.008, 0.010)),
    mouth_y=-0.0875,
    neck_r=0.042,
    eye=(0.0315, -0.067, 0.005), eye_r=0.0120,
    fissure=(0.0156, 0.0047, 0.0045), nose_k=0.0045,
    tilt=0.0016,
    nose=0.62, nose_w=0.80, nose_len=0.78, nose_top=0.010, nose_up=0.0018,
    apple=((0.036, -0.066, -0.026), (0.014, 0.008, 0.011)), fold_z=0.0018,
    lid=0.0014,
    lips=1.4, lip_w=0.97,
    fold=0.15,
    stubble=0.0,
)

OLD_MALE = dict(MALE, name="male_old", age=1.0, fold=1.0, fissure=(0.0142, 0.0036, 0.0038),
                nose=1.08, nose_len=1.06, lips=0.7)
OLD_FEMALE = dict(FEMALE, name="female_old", age=1.0, fold=0.9, fissure=(0.0146, 0.0040, 0.0040),
                  nose=0.9, nose_len=0.96, lips=0.8)

# A troll: brow like a shelf, a nose like a root, a jaw that juts past the
# upper lip, small deep eyes, a thick neck. It is a person's head pushed
# about, so it shares every edge the human ones have.
TROLL = dict(
    MALE, name="troll", sex="m",
    loft=_loft_scale(LOFT_MALE,
                     wk=[(0.1, 0.92), (0.03, 0.96), (-0.03, 1.08), (-0.07, 1.16), (-0.10, 1.25), (-0.12, 1.4)],
                     fk=[(0.1, 0.82), (0.05, 0.86), (0.02, 0.98), (-0.03, 1.02), (-0.07, 1.10), (-0.10, 1.12), (-0.12, 1.15)],
                     bk=[(0.1, 0.95), (-0.12, 1.05)],
                     nk=[(0.1, 1.05), (-0.12, 1.05)]),
    dome=((0.0, 0.020, 0.048), (0.064, 0.084, 0.058)),
    brow=2.0,
    cheek=((0.056, -0.056, -0.020), (0.020, 0.016, 0.013)),
    chin=((0.0, -0.094, -0.104), (0.026, 0.014, 0.016)),
    mouth_z=-0.068, mouth_y=-0.0980,
    neck_r=0.066,
    eye=(0.0315, -0.074, 0.004), eye_r=0.0110,
    fissure=(0.0132, 0.0052, 0.0046), iris=(0.10, 0.06, 0.01), sclera=(0.45, 0.42, 0.25),
    tilt=-0.0012,
    nose=2.0, nose_w=1.7, nose_len=1.45,
    lips=1.1, lip_w=1.2,
    # No age: its hollows are cut for a man's cheek and went straight
    # through a troll's into the mouth.
    fold=1.0, age=0.0, stubble=0.0,
)

# A wererat: the man's head drawn out into a muzzle, the nose at the end of
# it, small black eyes set to the side, big round ears high on the skull.
RAT = dict(
    MALE, name="wererat",
    loft=_loft_scale(LOFT_MALE,
                     wk=[(0.1, 0.98), (0.02, 0.96), (-0.02, 0.86), (-0.06, 0.74), (-0.10, 0.70), (-0.12, 0.8)],
                     fk=[(0.1, 0.98), (0.03, 1.0), (0.0, 1.18), (-0.03, 1.55), (-0.055, 1.62), (-0.08, 1.30), (-0.10, 1.0), (-0.12, 0.85)],
                     nk=[(0.1, 1.0), (0.02, 0.8), (-0.03, 0.46), (-0.06, 0.46), (-0.12, 0.7)]),
    brow=0.3, cheek=((0.040, -0.060, -0.016), (0.008, 0.008, 0.006)), nose_fwd=0.036,
    chin=((0.0, -0.080, -0.098), (0.008, 0.008, 0.008)),
    mouth_z=-0.070, mouth_y=-0.118,
    eye=(0.0360, -0.058, 0.010), eye_r=0.0100, fissure=(0.0095, 0.0048, 0.0046), tilt=0.0,
    nose=1.1, nose_w=1.25, nose_len=0.95, nose_top=0.004,
    lips=0.5, lip_w=0.6, fold=0.0, stubble=0.0,
    iris=(0.010, 0.008, 0.007), sclera=(0.02, 0.018, 0.016), limbus=(0.01, 0.01, 0.01),
    ear_scale=(1.3, 1.7, 1.55), ear_at=(0.002, 0.012, 0.040), ear_turn=34, brows=False,
)

# A mind flayer: a bulging, earless, noseless cranium, blank white eyes,
# and four tentacles where the mouth should be.
ILLITHID = dict(
    MALE, name="illithid",
    loft=_loft_scale(LOFT_MALE, wk=[(0.1, 1.06), (0.03, 1.02), (-0.03, 0.94), (-0.12, 0.82)],
                     fk=[(0.1, 1.0), (0.0, 0.98), (-0.06, 0.96), (-0.12, 0.9)],
                     bk=[(0.1, 1.12), (0.0, 1.08), (-0.12, 1.0)]),
    dome=((0.0, 0.028, 0.066), (0.078, 0.108, 0.068)),
    brow=0.6, no_features=True, ears=False, brows=False, tentacles=True,
    cheek=((0.050, -0.056, -0.014), (0.010, 0.010, 0.008)),
    eye=(0.0335, -0.064, 0.006), eye_r=0.0132, fissure=(0.0160, 0.0062, 0.0056), tilt=0.0025,
    iris=(0.55, 0.55, 0.60), pupil=(0.40, 0.40, 0.46), sclera=(0.68, 0.68, 0.72), limbus=(0.5, 0.5, 0.55),
    fold=0.0, stubble=0.0,
)

ETTIN = dict(TROLL, name="ettin", double=True)

SPECS = {s["name"]: s for s in (MALE, FEMALE, OLD_MALE, OLD_FEMALE, TROLL, RAT, ILLITHID, ETTIN)}

# Which faces each body carries, by file: the young and the old of each sex.
# Every face of one body shares its eyes, its skull and its ears, so hair and
# hats and the eye bones fit all of them.
FACES = {
    "male": [("face_male", MALE), ("face_male_old", OLD_MALE), ("face_wererat", RAT),
             ("face_illithid", ILLITHID)],
    "female": [("face_female", FEMALE), ("face_female_old", OLD_FEMALE)],
    "troll": [("face_troll", TROLL), ("face_ettin", ETTIN)],
}

# Where the per-person bones pivot, canonical: the jaw from the middle of
# the head so it widens and lengthens the lower face, the nose from its root.
JAW_PIVOT = (0.0, -0.010, -0.034)
NOSE_PIVOT = (0.0, -0.086, 0.010)


def spec_for(P):
    return {"male": MALE, "female": FEMALE, "troll": TROLL}[P["name"]]


def canon_to_world(P, co):
    w, _ = to_world(P, np.array([co], float))
    return tuple(float(v) for v in w[0])


def world_to_canon(P, co):
    import people
    hw, hd, hh = P["head"]
    s = np.array([hw / 0.077, hd / 0.100, hh / 0.118])
    c = np.array(people.head_center(P)[:])
    return (np.asarray(co, float) - c) / s


def region_weights(p):
    """How much of the jaw and of the nose bone each canonical point
    belongs to. Soft, so scaling either bone swells a region rather than
    tearing it off the face."""
    x, y, z = np.abs(p[:, 0]), p[:, 1], p[:, 2]
    front = np.clip((0.035 - y) / 0.05, 0.0, 1.0)
    jaw = np.clip((-0.045 - z) / 0.035, 0.0, 1.0) * front * np.clip((0.075 - x) / 0.02, 0, 1)
    jaw = jaw * jaw * (3 - 2 * jaw)
    nose = (np.clip((0.022 - x) / 0.010, 0, 1) * np.clip((-0.074 - y) / 0.010, 0, 1)
            * np.clip((0.014 - z) / 0.012, 0, 1) * np.clip((z + 0.052) / 0.008, 0, 1))
    nose = nose * nose * (3 - 2 * nose)
    return jaw, nose


def rig_weights(obj, P, eye_side=None):
    """Vertex groups for a piece worn on the face: the head, less what the
    jaw and the nose take. `eye_side` puts a whole piece on one eye."""
    for gname in list(obj.vertex_groups.keys()):
        obj.vertex_groups.remove(obj.vertex_groups[gname])
    if eye_side is not None:
        g_ = obj.vertex_groups.new(name="eye." + ("L" if eye_side > 0 else "R"))
        g_.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
        return obj
    co = world_to_canon(P, np.array([v.co[:] for v in obj.data.vertices]))
    jaw, nose = region_weights(co)
    gh = obj.vertex_groups.new(name="head")
    gj = obj.vertex_groups.new(name="jaw")
    gn = obj.vertex_groups.new(name="nose")
    for i in range(len(co)):
        h = max(0.0, 1.0 - jaw[i] - nose[i])
        if h > 1e-4:
            gh.add([i], float(h), "REPLACE")
        if jaw[i] > 1e-4:
            gj.add([i], float(jaw[i]), "REPLACE")
        if nose[i] > 1e-4:
            gn.add([i], float(nose[i]), "REPLACE")
    return obj


def _catmull(table, n=600):
    """The loft's rows, resampled smoothly on a fine z grid."""
    t = np.array(table, float)
    t = t[np.argsort(t[:, 0])]
    zs = np.linspace(t[0, 0], t[-1, 0], n)
    out = np.zeros((n, t.shape[1]))
    out[:, 0] = zs
    for col in range(1, t.shape[1]):
        # Monotone-ish cubic: Catmull-Rom through the rows, by segment.
        z, v = t[:, 0], t[:, col]
        idx = np.clip(np.searchsorted(z, zs) - 1, 0, len(z) - 2)
        z0, z1 = z[idx], z[idx + 1]
        u = (zs - z0) / (z1 - z0)
        p0 = v[np.maximum(idx - 1, 0)]
        p1, p2 = v[idx], v[idx + 1]
        p3 = v[np.minimum(idx + 2, len(z) - 1)]
        out[:, col] = 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
                             + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)
    return out


def loft_field(table):
    """Distance, roughly, to the lofted mass of the head."""
    fine = _catmull(table)
    zlo, zhi = fine[0, 0], fine[-1, 0]

    def f(p):
        z = np.clip(p[:, 2], zlo, zhi)
        W = np.interp(z, fine[:, 0], fine[:, 1])
        F = np.interp(z, fine[:, 0], fine[:, 2])
        B = np.interp(z, fine[:, 0], fine[:, 3])
        n = np.interp(z, fine[:, 0], fine[:, 4])
        x = np.abs(p[:, 0])
        y = p[:, 1]
        front = y < 0
        D = np.where(front, F, B)
        nn = np.where(front, n, 2.0)
        t = ((x / W) ** nn + (np.abs(y) / D) ** nn) ** (1.0 / nn)
        # Inside, the scaled section is a fair distance; outside it is not --
        # under the chin, where a section is a few millimetres across, it
        # called a point six centimetres off the face a millimetre away, and
        # anything offset from the head (a beard, a head of hair) came out as
        # a wedge. Outside, the distance along the ray from the axis instead.
        r = np.sqrt(x * x + y * y)
        d = np.where(t > 1.0, r * (1.0 - 1.0 / np.maximum(t, 1e-6)) * 0.95,
                     (t - 1.0) * np.minimum(W, D) * 0.9)
        # Capped top and bottom: the dome and the neck do the rest.
        over = p[:, 2] - zhi - 0.004
        under = zlo - p[:, 2]
        cap = np.maximum(over, under)
        d = np.where(cap > 0, np.sqrt(np.maximum(d, 0.0) ** 2 + cap * cap), d)
        return d
    return f


def lips_of(S):
    """The two lips as one distance function: two rolls meeting in a crease,
    the upper one bowed down in the middle, both following the arch round so
    the corners of the mouth sit back in the face."""
    lk, lw = S["lips"], S["lip_w"]
    lz = S["mouth_z"]
    ly = S["mouth_y"]

    def f(p):
        x = p[:, 0]
        # The arch: the corners of the mouth are further back than the middle.
        back = (x / (0.024 * lw)) ** 2 * 0.010
        pp = p.copy()
        pp[:, 1] = p[:, 1] - back
        # Cupid's bow: the upper lip's lower edge dips in the middle.
        pp[:, 2] = p[:, 2] + 0.0004 * g(x / 0.006, 1.0)
        up = ell(pp, (0.0, ly + 0.0080, lz + 0.0033), (0.0228 * lw, 0.0080, 0.0033 + 0.0008 * lk))
        lo = ell(pp, (0.0, ly + 0.0085, lz - 0.0040), (0.0200 * lw, 0.0080, 0.0038 + 0.0011 * lk))
        return smin(up, lo, 0.0010)
    return f


def plane(p, point, normal):
    """Signed distance to a plane, positive on the side the normal points."""
    n = np.asarray(normal, float)
    n = n / np.sqrt((n * n).sum())
    return (p - np.asarray(point, float)) @ n


def field(S):
    """The head's signed distance function for spec S: a function of an (N, 3)
    array of canonical points."""
    br = S["brow"]
    ex, ey, ez = S["eye"]
    er = S["eye_r"]
    fw, fu, fl = S["fissure"]
    nk, nw, nl = S["nose"], S["nose_w"], S["nose_len"]
    age = S["age"]
    lips = lips_of(S)
    lz = S["mouth_z"]
    mass = loft_field(S["loft"])

    def f(p):
        x = np.abs(p[:, 0])
        q = np.stack([x, p[:, 1], p[:, 2]], 1)          # mirrored: left side only
        dx, dr = S["dome"]
        d = smin(smax(mass(p), p[:, 2] - 0.090, 0.008), ell(p, dx, dr), 0.010)
        # The neck, under the jaw and behind it; cut flat where it goes into
        # the body's own neck.
        nr = S["neck_r"]
        neck = seg(p * np.array([1.06, 1.0, 1.0]), (0.0, 0.004, -0.080), (0.0, 0.006, -0.170), nr)
        d = smin(d, neck, 0.010)
        d = np.maximum(d, -0.150 - p[:, 2])
        # Cheekbones, a little proud of the loft, and the chin's knob.
        d = smin(d, ell(q, *S["cheek"]), 0.014)
        if S["apple"]:
            # The round of a woman's cheek, below and in from the bone.
            d = smin(d, ell(q, *S["apple"]), 0.016)
        d = smin(d, ell(p, *S["chin"]), 0.010)
        # Brow ridge: a bar over each eye from the glabella out, thinning.
        if br > 0:
            d = smin(d, seg(q, (0.0, -0.084 - 0.002 * br, 0.022), (0.046, -0.072 - 0.002 * br, 0.028),
                            0.0050 + 0.0025 * br, 0.0040 + 0.0015 * br), 0.010 + 0.003 * br)
        # Eye sockets: a shallow bowl under the brow, over the cheek.
        d = smax(d, -ell(q, (ex + 0.001, ey - 0.019, ez + 0.006), (0.017, 0.010, 0.012)), 0.007)
        # The lids: a shell round the eyeball, less the almond the eye shows
        # through. u runs out from the nose, w up.
        u = q[:, 0] - ex
        w = p[:, 2] - ez - S["tilt"] * np.clip(u / fw, -1.0, 1.0)
        k = np.clip(1.0 - (u / fw) ** 2, 0.0, 1.0)
        up = fu * k ** 0.62
        lo = -fl * k ** 0.75
        opening = np.maximum(np.maximum(w - up, lo - w), np.abs(u) - fw)
        ball = _len(q - np.array([ex, ey, ez])) - (er + S["lid"])
        lid = np.maximum(ball, -opening)
        # The fold of the upper lid: a roll of skin over it, under the brow.
        lid = smin(lid, ell(q, (ex + 0.001, ey - 0.0085, ez + fu + S["fold_z"]), (0.0150, 0.0046, 0.0030)), 0.002)
        d = smin(d, lid, 0.0025)
        # Old eyes: bags under them.
        if age > 0:
            d = smin(d, ell(q, (ex + 0.002, ey - 0.009, ez - fl - 0.006), (0.012, 0.0045, 0.0040)), 0.004 * age)
        if S.get("no_features"):
            return d
        # The nose: bridge, tip and wings, and the two nostrils under them.
        fwd = S.get("nose_fwd", 0.0)
        top = np.array([0.0, -0.086 - fwd * 0.4, S["nose_top"]])
        tip = np.array([0.0, -0.084 - 0.025 * nk - fwd, 0.012 - 0.044 * nl + S["nose_up"]])
        d = smin(d, seg(p, top, tip + np.array([0.0, 0.003, 0.004]), 0.0046 * nw, 0.0066 * nw), S.get("nose_k", 0.007))
        d = smin(d, ell(p, tip, np.array([0.0084 * nw, 0.0080, 0.0076]) * max(1.0, nk ** 0.4)), 0.005)
        wing = np.array([0.0110 * nw, tip[1] + 0.012, tip[2] - 0.002])
        d = smin(d, ell(q, wing, (0.0062 * nw, 0.0078, 0.0060)), 0.005)
        d = smax(d, -ell(q, (0.0054 * nw, tip[1] + 0.006, tip[2] - 0.0078), (0.0030 * nw, 0.0042, 0.0018)), 0.0012)
        # Lips, meeting in a crease that is the mouth.
        d = smin(d, lips(p), 0.0030)
        # The groove from the wing of the nose to the corner of the mouth.
        fd = S["fold"]
        if fd > 0:
            d = smax(d, -seg(q, (0.019, -0.088, -0.036), (0.028, -0.079, lz - 0.006), 0.0015 + 0.0012 * fd),
                     0.004 + 0.003 * fd)
        # Age: the jowl sags over the jawline, the cheek hollows under the
        # bone, and three lines cross the forehead.
        if age > 0:
            d = smin(d, ell(q, (0.040, -0.055, -0.090), (0.013, 0.011, 0.011)), 0.010 * age)
            d = smax(d, -ell(q, (0.048, -0.082, -0.040), (0.012, 0.010, 0.014)), 0.010 * age)
            fore = g(p[:, 2] - 0.058, 0.022) * g(x / 0.045, 1.0) * np.clip((-p[:, 1] - 0.06) / 0.02, 0, 1)
            d = d + 0.00045 * age * fore * np.sin(p[:, 2] * 2 * math.pi / 0.0105)
        return d
    return f


def grad(f, p, e=0.00025):
    ex = np.array([e, 0, 0])
    ey = np.array([0, e, 0])
    ez = np.array([0, 0, e])
    n = np.stack([f(p + ex) - f(p - ex), f(p + ey) - f(p - ey), f(p + ez) - f(p - ez)], 1)
    return n / np.maximum(_len(n)[:, None], 1e-12)


def occlusion(f, p, n, steps=5, reach=0.012):
    """The field's own ambient occlusion: how far short of free space the
    field is at a few steps out along the normal."""
    ao = np.zeros(len(p))
    for i in range(1, steps + 1):
        h = reach * i / steps
        ao += (h - np.minimum(f(p + n * h), h)) / (2.0 ** i)
    return np.clip(1.0 - ao * 2.2 / reach * 1.0, 0.0, 1.0)


def project(f, origin, dirs, far=0.22):
    """March in from `far` along each direction towards `origin` until the
    field says inside, then bisect back to the crossing: the outermost
    surface on every ray. The bisection matters -- the loft's distance is
    only an estimate, generous over the crown, and a march that stops a step
    inside the skin leaves a terrace round the head."""
    o = np.asarray(origin, float)
    t = np.full(len(dirs), far)
    prev = t.copy()
    done = np.zeros(len(dirs), bool)
    for it in range(600):
        p = o + dirs * t[:, None]
        d = f(p)
        hit = (d < 0) & ~done
        done |= hit
        if done.all():
            break
        live = ~done
        prev[live] = t[live]
        step = np.maximum(d * 0.6, 0.0001)
        t[live] = np.maximum(t[live] - step[live], 0.0)
    lo, hi = t.copy(), prev.copy()          # inside, outside
    for it in range(16):
        mid = (lo + hi) / 2
        inside = f(o + dirs * mid[:, None]) < 0
        lo = np.where(inside, mid, lo)
        hi = np.where(inside, hi, mid)
    return o + dirs * ((lo + hi) / 2)[:, None]


def settle(f, p, iters=3):
    """Newton steps back onto the surface along the gradient."""
    for _ in range(iters):
        n = grad(f, p)
        p = p - n * f(p)[:, None]
    return p


# --- meshing ------------------------------------------------------------------

def _icosphere(level):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=level, radius=1.0)
    verts = np.array([v.co[:] for v in bm.verts])
    faces = [[v.index for v in fc.verts] for fc in bm.faces]
    bm.free()
    return verts, faces


def mesh_field(f, name, origin, level=6, keep=None, target=None, mat="skin", symmetric=True):
    """A mesh of the field's outer surface, from a ray per icosphere vertex.
    `keep(points)` drops faces with any vertex outside; `target` decimates."""
    dirs, faces = _icosphere(level)
    pts = project(f, origin, dirs)
    if keep is not None:
        ok = keep(pts)
        faces = [fc for fc in faces if all(ok[i] for i in fc)]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(p) for p in pts], [], faces)
    me.validate()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, mat)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(me)
    bm.free()
    if target:
        dm = obj.modifiers.new("decimate", "DECIMATE")
        me.calc_loop_triangles()
        dm.ratio = min(1.0, target / max(1, len(me.loop_triangles)))
        dm.use_collapse_triangulate = True
        dm.use_symmetry = symmetric
        dm.symmetry_axis = "X"
        _apply(obj)
    # Back onto the surface: a collapse puts the merged vertex where the
    # quadric likes it, a hair off the field.
    co = np.array([v.co[:] for v in obj.data.vertices])
    co = settle(f, co)
    for v, c in zip(obj.data.vertices, co):
        v.co = c
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def _apply(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def set_normals(obj, normals):
    """Vertex normals from the field, as custom normals, so the shading is
    the field's and not the triangulation's."""
    me = obj.data
    me.normals_split_custom_set_from_vertices([tuple(n) for n in normals])


def set_colors(obj, cols, name="Col"):
    me = obj.data
    attr = me.color_attributes.get(name) or me.color_attributes.new(name, "FLOAT_COLOR", "POINT")
    for i, c in enumerate(cols):
        attr.data[i].color = (float(c[0]), float(c[1]), float(c[2]), 1.0)
    me.color_attributes.active_color = attr
    return attr


def white(obj, name="Col"):
    """A plain white colour attribute, so a mesh that carries no colour of its
    own still exports one: the viewer's materials multiply by it."""
    me = obj.data
    if me.color_attributes.get(name):
        return
    attr = me.color_attributes.new(name, "FLOAT_COLOR", "POINT")
    for d in attr.data:
        d.color = (1.0, 1.0, 1.0, 1.0)
    me.color_attributes.active_color = attr


# --- colour ------------------------------------------------------------------

def skin_colour(S, p, n, ao):
    """Multipliers over the skin tint, per vertex."""
    x = np.abs(p[:, 0])
    y, z = p[:, 1], p[:, 2]
    front = np.clip(-n[:, 1] * 1.4, 0, 1)
    c = np.ones((len(p), 3))
    # Cavities darken, and go a touch warm, as light does that has bounced
    # round inside skin.
    cav = 0.55 + 0.45 * ao ** 1.4
    c *= np.stack([cav ** 0.9, cav, cav ** 1.08], 1)
    ld = lips_of(S)(p)
    lips = np.clip(1.0 - ld / 0.0022, 0, 1) * front
    # The line of the mouth itself, dark where the lips meet.
    lz = S["mouth_z"]
    mouth = g((z - lz) / 0.0011, 1.0) * np.clip(1.0 - ld / 0.001, 0, 1)
    # A woman's lips a deeper rose than a man's: the one colour on a face
    # that says which it is from across a square.
    c *= 1.0 - lips[:, None] * (np.array([0.06, 0.34, 0.28]) if S["sex"] == "f" else np.array([0.04, 0.16, 0.14]))
    c *= 1.0 - mouth[:, None] * 0.45
    # A flush on the cheeks, the nose and the ears.
    flush = (g(x - 0.042, 0.016) * g(z + 0.030, 0.016) + g(x / 0.012, 1.0) * g(z + 0.030, 0.014) * 0.7
             + g(x - 0.078, 0.012) * g(z + 0.012, 0.030) * 0.8)
    c *= 1.0 - np.clip(flush, 0, 1)[:, None] * np.array([0.0, 0.08, 0.09])
    # The lash line: darkest along the upper lid margin.
    ex, ey, ez = S["eye"]
    fw, fu, fl = S["fissure"]
    u = x - ex
    k = np.clip(1.0 - (u / fw) ** 2, 0.0, 1.0)
    w = z - ez - S["tilt"] * np.clip(u / fw, -1, 1)
    lash = g((w - fu * k ** 0.62) / 0.0014, 1.0) * (k > 0.02) * g(u / (fw * 1.1), 1.0) ** 0.3
    lash *= _len(p - np.array([0, 0, 0]) * 0) > 0
    lash = np.clip(lash * (_len(np.stack([u, y - ey, w], 1)) < S["eye_r"] + S["lid"] + 0.003), 0, 1)
    low = g((w + fl * k ** 0.75) / 0.0012, 1.0) * (k > 0.02)
    low = np.clip(low * (_len(np.stack([u, y - ey, w], 1)) < S["eye_r"] + S["lid"] + 0.002), 0, 1)
    fem = S["sex"] == "f"
    c *= 1.0 - (lash * (0.85 if fem else 0.65) + low * (0.45 if fem else 0.28))[:, None]
    # A man's beard shadow on the jaw and the upper lip.
    if S["stubble"]:
        beard = np.clip((-0.036 - z) / 0.012, 0, 1) * np.clip((0.070 - x) / 0.02, 0, 1) * (1 - lips)
        beard *= np.clip((-y + 0.02) / 0.03, 0, 1)
        beard *= 1.0 - g((z + 0.036) / 0.012, 1.0) * g(x / 0.03, 1.0) * 0.0
        beard = beard * (1.0 - np.clip((z + 0.13) / -0.02, 0, 1))
        c *= 1.0 - (S["stubble"] * 0.10 * beard)[:, None] * np.array([1.0, 0.95, 0.85])
    return c


# --- building one -------------------------------------------------------------

def to_world(P, co):
    import people
    hw, hd, hh = P["head"]
    s = np.array([hw / 0.077, hd / 0.100, hh / 0.118])
    c = np.array(people.head_center(P)[:])
    return c + co * s, s


def ear(S, P, side, name="ear"):
    """An ear: a flattened disc with a rim, the bowl of the concha pressed
    into its outer face and a lobe at the bottom, meshed like the head and
    set against the side of it swept back."""
    def f(p):
        # Ear-local: x out from the head, y back, z up.
        x, y, z = p[:, 0], p[:, 1], p[:, 2]
        d = ell(p, (-0.001, 0.0, 0.001), (0.0055, 0.0160, 0.0290))
        # The lobe, soft and hanging.
        d = smin(d, ell(p, (0.0, -0.001, -0.021), (0.0052, 0.0085, 0.0090)), 0.005)
        # The helix: a rolled rim round the top and the back.
        e = np.sqrt((y / 0.0150) ** 2 + ((z - 0.002) / 0.0272) ** 2) - 1.0
        rim = np.sqrt((x - 0.0012) ** 2 + (e * 0.018) ** 2) - 0.0030
        rim = np.maximum(rim, -(z + 0.004 * 0) - 0.012 + 0.0 * y)
        rim = np.maximum(rim, -(y + 0.006) - (z > 0.0) * 0.02)
        d = smin(d, rim, 0.0025)
        # The concha and the scapha, pressed in from the outside.
        d = smax(d, -ell(p, (0.0070, -0.0010, -0.003), (0.0048, 0.0078, 0.0110)), 0.0022)
        d = smax(d, -ell(p, (0.0062, 0.0035, 0.012), (0.0032, 0.0060, 0.0110)), 0.0018)
        return d
    obj = mesh_field(f, name, (-0.002, 0.0, 0.0), level=5, target=240, symmetric=False)
    co = np.array([v.co[:] for v in obj.data.vertices])
    n = grad(f, co)
    ao = occlusion(f, co, n, reach=0.006)
    co = co * np.array(S.get("ear_scale", (1.0, 1.0, 1.0)))
    # Set against the head: out from it by a little, swept back at the top,
    # and turned away from the skull behind.
    import mathutils
    R = (mathutils.Matrix.Rotation(side * math.radians(S.get("ear_turn", 18)), 3, "Z") @
         mathutils.Matrix.Rotation(math.radians(-12), 3, "X"))
    ex, ey, ez = S["eye"]
    base = np.array([side * 0.0735, 0.006, -0.010]) + np.array(S.get("ear_at", (0.0, 0.0, 0.0))) * \
        np.array([side, 1.0, 1.0])
    if S["name"] == "troll":
        base = np.array([side * 0.0715, 0.010, -0.004])
    M = np.array(R)
    flip = np.array([side, 1.0, 1.0])
    loc = (co * flip) @ M.T + base
    nn = (n * flip) @ M.T
    return obj, loc, nn, ao, f


def build(S, P, name=None, target=2400, ears=True):
    """The head of spec S on a body with table P: one object, skin, with the
    ears in it. Returns (obj, field, canonical coordinates of the vertices)."""
    f = field(S)
    name = name or "face_" + S["name"]
    obj = mesh_field(f, name, (0.0, 0.006, -0.018), level=7,
                     keep=lambda p: p[:, 2] > -0.150 + 0.004, target=target)
    co = np.array([v.co[:] for v in obj.data.vertices])
    n = grad(f, co)
    ao = occlusion(f, co, n)
    cols = skin_colour(S, co, n, ao)
    parts = [(obj, co, n, cols)]
    for side in ((1, -1) if ears else ()):
        e, loc, nn, eao, _ = ear(S, P, side)
        ecol = np.ones((len(loc), 3)) * (0.35 + 0.65 * eao ** 1.3)[:, None]
        ecol *= np.array([1.0, 0.90, 0.88])
        parts.append((e, loc, nn, ecol))
    # Everything into place in the world, then joined.
    objs = []
    allc, alln, allcol = [], [], []
    for (o, c, nrm, col) in parts:
        w, s = to_world(P, c)
        for v, p in zip(o.data.vertices, w):
            v.co = p
        nw = nrm / s
        nw /= _len(nw)[:, None]
        allc.append(c)
        alln.append(nw)
        allcol.append(col)
        objs.append(o)
    import people
    head = people.join(objs, name)
    set_normals(head, np.concatenate(alln))
    set_colors(head, np.concatenate(allcol))
    return head, f, np.concatenate(allc)


def eyes(S, P, name="eyes"):
    """Two eyeballs, poles on the line of sight, so the rings round the pole
    are the pupil, the iris and the limbus: the colours go on rings and the
    edges are clean. The cornea stands a little proud over the iris. Each is
    its own island so it can be put on its own bone and turned."""
    ex, ey, ez = S["eye"]
    r = S["eye_r"]
    rings = [0.0, 7.0, 13.0, 19.0, 24.0, 28.0, 40.0, 60.0, 85.0, 115.0, 150.0]
    sides = 14
    out = []
    for side in (1, -1):
        c = np.array([side * ex, ey, ez])
        verts, faces, cols = [], [], []
        verts.append(c + np.array([0, -r - 0.0009, 0]))
        cols.append((0.008, 0.007, 0.006))
        for a in rings[1:]:
            t = math.radians(a)
            bulge = 0.0009 * max(0.0, 1.0 - a / 26.0) ** 0.6
            for i in range(sides):
                phi = 2 * math.pi * i / sides
                dx = math.sin(t) * math.cos(phi)
                dz = math.sin(t) * math.sin(phi)
                dy = -math.cos(t)
                verts.append(c + np.array([dx, dy, dz]) * (r + bulge))
                # Linear values, as the attribute is read: a pupil, a brown
                # iris darker at its rim, the limbus ring, and a sclera that is
                # off-white and pinker towards the corners -- a full white one
                # at this size is a doll's stare.
                iris = S.get("iris", (0.075, 0.042, 0.020))
                sclera = S.get("sclera", (0.60, 0.55, 0.50))
                if a <= 7.0:
                    cols.append(S.get("pupil", (0.008, 0.007, 0.006)))
                elif a <= 19.0:
                    cols.append(iris if a < 16 else tuple(c * 0.66 for c in iris))
                elif a <= 24.0:
                    cols.append(S.get("limbus", (0.018, 0.014, 0.011)))
                else:
                    cols.append(sclera if a < 70 else tuple(c * 0.8 for c in sclera))
        back = len(verts)
        verts.append(c + np.array([0, r, 0]))
        cols.append((0.5, 0.38, 0.34))
        n = len(rings) - 1
        for i in range(sides):
            faces.append((0, 1 + (i + 1) % sides, 1 + i))
        for k in range(n - 1):
            b = 1 + k * sides
            for i in range(sides):
                j = (i + 1) % sides
                faces.append((b + i, b + j, b + j + sides, b + i + sides))
        b = 1 + (n - 1) * sides
        for i in range(sides):
            faces.append((b + i, b + (i + 1) % sides, back))
        me = bpy.data.meshes.new("eye")
        w, s = to_world(P, np.array(verts))
        me.from_pydata([tuple(p) for p in w], [], faces)
        me.validate()
        o = bpy.data.objects.new("eye", me)
        bpy.context.collection.objects.link(o)
        lib.assign(o, "eyewhite")
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        for pl in me.polygons:
            pl.use_smooth = True
        set_colors(o, cols)
        o["side"] = side
        out.append(o)
    return out


def brows(S, P, f, hair_scale=1.0, name="brows"):
    """Eyebrows: a tapering strip of hair laid on the brow ridge, following
    the skin a millimetre off it, thick at the inner end and feathering out."""
    ex, ey, ez = S["eye"]
    out = []
    thick = 1.0 if S["sex"] == "m" else 0.72
    for side in (1, -1):
        cols = 9
        verts, faces, colr = [], [], []
        for i in range(cols):
            t = i / (cols - 1)
            x = 0.011 + t * 0.043
            # An arch: highest two-thirds of the way out.
            zc = ez + 0.0165 + 0.0055 * math.sin(math.pi * min(1.0, t / 0.72) * 0.5) - 0.004 * max(0.0, (t - 0.72) / 0.28) ** 1.5
            if S["sex"] == "f":
                zc += 0.0022 + 0.002 * t
            hw = (0.0034 - 0.0019 * t) * thick
            for (dz, off) in ((-hw, 0.0002), (0.0, 0.0008 * thick), (hw, 0.0002)):
                p = np.array([[x, -0.12, zc + dz]])
                # onto the skin, from the front
                p = project(f, np.array([x, 0.0, zc + dz]), np.array([[0.0, -1.0, 0.0]]), far=0.13)
                p = settle(f, p)
                nrm = grad(f, p)
                verts.append(p[0] + nrm[0] * off)
            fade = min(1.0, t / 0.12) * (1.0 - max(0.0, (t - 0.8) / 0.2) * 0.5)
            colr += [(1, 1, 1)] * 3
        for i in range(cols - 1):
            b = i * 3
            faces.append((b, b + 3, b + 4, b + 1))
            faces.append((b + 1, b + 4, b + 5, b + 2))
        verts = np.array(verts)
        verts[:, 0] *= side
        w, s = to_world(P, verts)
        me = bpy.data.meshes.new("brow")
        me.from_pydata([tuple(p) for p in w], [], [fc if side > 0 else fc[::-1] for fc in faces])
        me.validate()
        o = bpy.data.objects.new("brow", me)
        bpy.context.collection.objects.link(o)
        lib.assign(o, "hair")
        for pl in me.polygons:
            pl.use_smooth = True
        set_colors(o, colr)
        out.append(o)
    return out


def skull(P, name="skull"):
    """A bare skull for the skeletons: the man's loft with the flesh taken
    off -- the orbits and the nasal opening cut deep, the cheeks hollowed
    under the zygomatic arch, the temples sunk -- in bone, the cavities dark
    in the vertex colour."""
    S = MALE
    mass = loft_field(_loft_scale(LOFT_MALE, wk=[(0.1, 1.0), (0.0, 0.97), (-0.06, 0.90), (-0.12, 0.92)],
                                  fk=[(0.1, 1.0), (0.0, 0.97), (-0.06, 0.95), (-0.12, 0.97)]))
    dx, dr = S["dome"]

    def f(p):
        x = np.abs(p[:, 0])
        q = np.stack([x, p[:, 1], p[:, 2]], 1)
        d = smin(smax(mass(p), p[:, 2] - 0.090, 0.008), ell(p, dx, dr), 0.010)
        d = np.maximum(d, -0.118 - p[:, 2])
        d = smin(d, seg(q, (0.0, -0.083, 0.022), (0.046, -0.071, 0.028), 0.006, 0.0045), 0.008)
        d = smin(d, ell(q, (0.052, -0.058, -0.014), (0.016, 0.013, 0.010)), 0.010)
        d = smax(d, -ell(q, (0.031, -0.074, 0.004), (0.0175, 0.022, 0.0165)), 0.003)
        d = smax(d, -ell(p, (0.0, -0.086, -0.030), (0.0095, 0.020, 0.0140)), 0.003)
        d = smax(d, -ell(q, (0.052, -0.055, -0.048), (0.014, 0.024, 0.020)), 0.010)
        d = smax(d, -ell(q, (0.076, -0.030, 0.014), (0.010, 0.024, 0.020)), 0.010)
        # The line of the teeth.
        d = smax(d, -ell(p, (0.0, -0.070, -0.066), (0.027, 0.022, 0.0012)), 0.0008)
        return d
    obj = mesh_field(f, name, (0.0, 0.006, -0.018), level=6, keep=lambda p: p[:, 2] > -0.117, target=1300)
    co = np.array([v.co[:] for v in obj.data.vertices])
    n = grad(f, co)
    ao = occlusion(f, co, n, reach=0.016)
    cav = np.clip(ao, 0, 1) ** 2.2
    cols = np.stack([0.18 + 0.82 * cav] * 3, 1) * np.array([1.0, 0.96, 0.9])
    w, sc = to_world(P, co)
    for v, pt in zip(obj.data.vertices, w):
        v.co = pt
    nw = n / sc
    nw /= _len(nw)[:, None]
    set_normals(obj, nw)
    set_colors(obj, cols)
    lib.assign(obj, "bone")
    return obj


def tentacles(S, P, f, name="tentacles"):
    """A mind flayer's face-tentacles: four tapering, drooping tubes from
    round the mouth, curling at the ends, in the same skin."""
    import people
    lz = S["mouth_z"]
    parts = []
    for k, (x, spread, length) in enumerate(((-0.026, -1.0, 0.12), (-0.009, -0.3, 0.15), (0.009, 0.3, 0.15),
                                             (0.026, 1.0, 0.12))):
        root = project(f, np.array([x, 0.0, lz + 0.012]), np.array([[0.0, -1.0, 0.0]]), far=0.15)[0]
        pts = [root + np.array([0.0, 0.006, 0.0])]
        d = np.array([spread * 0.25, -0.55, -1.0])
        d /= np.linalg.norm(d)
        n = 12
        for i in range(n):
            t = (i + 1) / n
            # Down, then curling forward and out at the end, each its own way.
            bend = np.array([spread * 0.25 * t + 0.1 * math.sin(t * 7 + k), -0.2 + 1.4 * t * t,
                             -1.0 + 0.9 * t ** 3])
            step = d * 0.6 + bend * 0.4
            step /= np.linalg.norm(step)
            pts.append(pts[-1] + step * length / n)
        rings = []
        verts, faces, cols = [], [], []
        sides = 8
        for i, c in enumerate(pts):
            t = i / (len(pts) - 1)
            T = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)])
            T /= np.linalg.norm(T)
            u = np.cross(T, [1.0, 0.0, 0.0])
            if np.linalg.norm(u) < 1e-3:
                u = np.cross(T, [0.0, 1.0, 0.0])
            u /= np.linalg.norm(u)
            v = np.cross(T, u)
            r = 0.0068 * (1.0 - 0.8 * t) + 0.0010
            for k in range(sides):
                a = 2 * math.pi * k / sides
                verts.append(c + (u * math.cos(a) + v * math.sin(a)) * r)
                # Paler underneath, where the suckers would be.
                cols.append((0.9, 0.85, 0.9) if math.sin(a) < -0.3 else (0.75, 0.7, 0.75))
        for i in range(len(pts) - 1):
            for k in range(sides):
                a0 = i * sides + k
                a1 = i * sides + (k + 1) % sides
                faces.append((a0, a1, a1 + sides, a0 + sides))
        tip = len(verts)
        verts.append(pts[-1] + (pts[-1] - pts[-2]) * 0.4)
        cols.append((0.7, 0.65, 0.7))
        last = (len(pts) - 1) * sides
        for k in range(sides):
            faces.append((last + k, last + (k + 1) % sides, tip))
        w, _ = to_world(P, np.array(verts))
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(q) for q in w], [], faces)
        me.validate()
        o = bpy.data.objects.new(name, me)
        bpy.context.collection.objects.link(o)
        lib.assign(o, "skin")
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        for pl in me.polygons:
            pl.use_smooth = True
        set_colors(o, cols)
        parts.append(o)
    return parts


def face(S, P, name):
    """Everything of a face as one object: the skin with the ears, the eyes
    on their bones, the brows. Rigged by vertex group, parented by the caller."""
    import people
    head, f, _ = build(S, P, name, ears=S.get("ears", True))
    rig_weights(head, P)
    parts = [head]
    for e in eyes(S, P):
        rig_weights(e, P, eye_side=e["side"])
        parts.append(e)
    if S.get("brows", True):
        for b in brows(S, P, f):
            rig_weights(b, P)
            parts.append(b)
    if S.get("tentacles"):
        for t in tentacles(S, P, f):
            t_ = t
            import rig
            rig.set_rigid(t_, "jaw")
            parts.append(t_)
    out = people.join(parts, name)
    out.data.name = name
    if S.get("double"):
        out = _two_headed(out, P, name)
    return out


def _two_headed(one, P, name):
    """An ettin: the face twice, side by side on the one neck, each turned a
    little away from the other. Only the first keeps its eyes' bones; the
    second's are fixed in its head, and neither takes the per-person jaw."""
    import people
    import rig
    import mathutils
    other = one.copy()
    other.data = one.data.copy()
    bpy.context.collection.objects.link(other)
    c = V(canon_to_world(P, (0.0, 0.0, -0.10)))
    for obj, side in ((one, 1), (other, -1)):
        M = (mathutils.Matrix.Translation(c + V((side * 0.125, 0.012, -0.030))) @
             mathutils.Matrix.Rotation(side * math.radians(20), 4, "Z") @
             mathutils.Matrix.Rotation(side * math.radians(-6), 4, "Y") @
             mathutils.Matrix.Translation(-c))
        obj.data.transform(M)
        if side < 0:
            rig.set_rigid(obj, "head")
        else:
            for g_ in ("jaw", "nose"):
                vg = obj.vertex_groups.get(g_)
                if vg:
                    idx = [v.index for v in obj.data.vertices]
                    obj.vertex_groups["head"].add(idx, 0.0, "ADD")
            for v in obj.data.vertices:
                w = 0.0
                for gr in v.groups:
                    if obj.vertex_groups[gr.group].name in ("jaw", "nose"):
                        w += gr.weight
                if w > 0:
                    obj.vertex_groups["head"].add([v.index], w, "ADD")
            for g_ in ("jaw", "nose"):
                vg = obj.vertex_groups.get(g_)
                if vg:
                    obj.vertex_groups.remove(vg)
    out = people.join([one, other], name)
    out.data.name = name
    return out


# --- looking at it -----------------------------------------------------------------

def studio(target=(0, 0, 1.6)):
    """Three-point light round a head at `target`: a warm key high to the
    front left, a cool fill low to the right, a rim from behind."""
    scene = bpy.context.scene
    for o in list(bpy.data.objects):
        if o.name.startswith("STUDIO_"):
            bpy.data.objects.remove(o, do_unlink=True)
    t = V(target)

    def light(name, kind, energy, loc, color, size=0.3):
        d = bpy.data.lights.new("STUDIO_" + name, type=kind)
        d.energy = energy
        d.color = color
        if kind == "AREA":
            d.size = size
        o = bpy.data.objects.new("STUDIO_" + name, d)
        bpy.context.collection.objects.link(o)
        o.location = t + V(loc)
        o.rotation_euler = (t - o.location).to_track_quat("-Z", "Y").to_euler()
        return o
    light("key", "AREA", 60, (-0.9, -1.1, 0.7), (1.0, 0.93, 0.85), 0.5)
    light("fill", "AREA", 18, (1.1, -0.9, 0.1), (0.8, 0.88, 1.0), 0.8)
    light("rim", "AREA", 45, (0.4, 1.2, 0.5), (1.0, 1.0, 1.0), 0.4)
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (0.18, 0.19, 0.21, 1.0)
    bg.inputs[1].default_value = 0.6


PREVIEW = {
    "skin": ((0.78, 0.56, 0.44, 1), 0.55, 0.0),
    "eyewhite": ((1, 1, 1, 1), 0.12, 0.0),
    "hair": ((0.16, 0.10, 0.06, 1), 0.5, 0.0),
    "cloth": ((0.35, 0.28, 0.22, 1), 0.9, 0.0),
    "cloth2": ((0.25, 0.25, 0.28, 1), 0.9, 0.0),
    "linen": ((0.75, 0.72, 0.64, 1), 0.9, 0.0),
    "leather": ((0.28, 0.18, 0.11, 1), 0.6, 0.0),
    "steel": ((0.75, 0.76, 0.78, 1), 0.3, 1.0),
    "iron": ((0.3, 0.3, 0.32, 1), 0.5, 0.9),
    "mail": ((0.5, 0.5, 0.52, 1), 0.45, 0.9),
    "gold": ((0.85, 0.65, 0.3, 1), 0.3, 1.0),
    "eye": ((0.02, 0.02, 0.02, 1), 0.2, 0.0),
    "bone": ((0.8, 0.76, 0.65, 1), 0.7, 0.0),
}


def preview_materials(tints=None):
    """Make the tagged materials look like themselves in a render: base
    colour times the vertex colour, the roughness the viewer gives them. The
    viewer swaps its own in by name, so this only changes what Blender
    shows."""
    tints = tints or {}
    for m in bpy.data.materials:
        if not m.name.startswith("MAT:"):
            continue
        tag = m.name[4:]
        col, rough, metal = PREVIEW.get(tag, ((0.5, 0.5, 0.5, 1), 0.8, 0.0))
        col = tints.get(tag, col)
        m.use_nodes = True
        nt = m.node_tree
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        for n in list(nt.nodes):
            if n.type in ("VERTEX_COLOR", "MIX_RGB", "MIX") or n.name.startswith("pv_"):
                nt.nodes.remove(n)
        vc = nt.nodes.new("ShaderNodeVertexColor")
        vc.name = "pv_vc"
        vc.layer_name = "Col"
        mul = nt.nodes.new("ShaderNodeMix")
        mul.name = "pv_mul"
        mul.data_type = "RGBA"
        mul.blend_type = "MULTIPLY"
        mul.inputs[0].default_value = 1.0
        mul.inputs[6].default_value = col
        nt.links.new(vc.outputs[0], mul.inputs[7])
        nt.links.new(mul.outputs[2], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        if tag == "skin":
            try:
                bsdf.inputs["Subsurface Weight"].default_value = 0.0
                bsdf.inputs["Subsurface Radius"].default_value = (0.01, 0.004, 0.002)
            except KeyError:
                pass


def portrait(path, center, azims=(0, 35, 90), dist=0.72, lens=85, res=(1500, 560), elev=3.0):
    import subprocess
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = 96
    scene.view_settings.view_transform = "AgX"
    tiles = []
    c = V(center)
    for i, az in enumerate(azims):
        cd = bpy.data.cameras.new("pcam")
        cd.lens = lens
        cam = bpy.data.objects.new("pcam", cd)
        bpy.context.collection.objects.link(cam)
        a = math.radians(az)
        e = math.radians(elev)
        cam.location = c + V((dist * math.sin(a) * math.cos(e), -dist * math.cos(a) * math.cos(e), dist * math.sin(e)))
        cam.rotation_euler = (c - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.camera = cam
        scene.render.resolution_x = res[0] // len(azims)
        scene.render.resolution_y = res[1]
        p = "/tmp/people2-tile-%d.png" % i
        scene.render.filepath = p
        bpy.ops.render.render(write_still=True)
        tiles.append(p)
        bpy.data.objects.remove(cam, do_unlink=True)
    subprocess.run(["montage"] + tiles + ["-tile", "x1", "-geometry", "+0+0", path])
    return path
