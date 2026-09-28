"""hair -- hair and beards in locks.

Every head of hair this project had before was a shell pushed out from the
skull with a ragged hairline, and every one of them read as a cap: one
smooth surface catches the light as one surface, however it is tinted.
Hair at street distance is clumps -- each catching the light a little
differently, each throwing a little shadow on the next -- and a silhouette
that breaks up where the clumps end.

So a head of hair here is two things:

* a mass: the scalp pushed out by the hair's volume (more on the crown,
  less over the ears), meshed from the head's own distance field and dark,
  so that wherever the locks part what shows between them is depth;
* locks: tapered, flattened strands grown over that mass along the style's
  flow -- away from a parting, out from the crown's whorl, back to a bun --
  lying on the head while there is head under them and falling free past it,
  with a collision field for the neck and the shoulders so long hair rests
  on the back instead of passing through it.

Beards are the same two things on the jaw, falling down. Each lock carries
its own shade in vertex colour, darker at the root, so the tint the viewer
lays over the hair material comes out as a head of hair and not as paint.

Coordinates as heads.py: a man's head's metres about the eye line, x to the
figure's left, y back, z up. Everything is built canonical and moved into
place by the body's head table.
"""

import math
import random

import numpy as np
import bpy
import bmesh

import lib
import heads
import rig

g = heads.g


# --- fields ------------------------------------------------------------------

def body_field(S):
    """The head, the neck, and the tops of the shoulders and the back, for
    long hair to rest on: canonical, so a woman's shoulders are where hers
    are relative to her head."""
    f = heads.field(S)
    fem = S["sex"] == "f"
    sw = 0.165 if fem else 0.185

    def fb(p):
        d = f(p)
        d = np.minimum(d, heads.seg(p, (0.0, 0.004, -0.06), (0.0, 0.0, -0.20), 0.052 if not fem else 0.046))
        # Shoulders and the upper back: a wide flattened ellipsoid under the
        # neck, and the trapezius slope rising from it.
        d = heads.smin(d, heads.ell(p, (0.0, 0.010, -0.285), (sw, 0.105, 0.105)), 0.03)
        return d
    return fb


def hairline(theta, recede=0.0):
    """Height of the hairline (about the eye line) all round the head, by
    angle from the front: a forehead, temples, clear over the ears, down the
    back to the nape. `recede` lifts the front and the temples."""
    a = abs(math.degrees(theta))
    base = [(0, 0.060), (30, 0.056), (52, 0.040), (66, 0.024), (80, 0.024), (96, 0.022),
            (112, -0.012), (140, -0.050), (180, -0.062)]
    z = float(np.interp(a, [x for x, _ in base], [y for _, y in base]))
    if recede:
        z += recede * float(np.interp(a, [0, 45, 70, 100], [0.016, 0.024, 0.006, 0.0]))
    return z


def theta_of(p):
    return np.arctan2(p[..., 0], -p[..., 1])


def scalp_mask(p, recede=0.0, soft=0.004):
    """1 where hair grows, fading to 0 across `soft` below the hairline."""
    th = theta_of(p)
    hl = np.array([hairline(t, recede) for t in np.ravel(th)]).reshape(np.shape(th))
    # A hairline is not a ruled line: fixed noise by angle, so both sides of
    # a face agree.
    hl = hl - 0.0016 * (1 + np.sin(th * 23.0)) - 0.0008 * (1 + np.sin(th * 41.0 + 1.3))
    return np.clip((p[..., 2] - hl) / soft + 0.5, 0.0, 1.0)


# --- geometry -----------------------------------------------------------------

def _mesh(name, verts, faces, cols, mat="hair"):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.validate()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, mat)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    heads.set_colors(obj, cols)
    return obj


def mass(S, name, thickness, grow, target=500, shade=0.42):
    """The hair's mass: the head's field pushed out by `thickness(p)` over
    the region `grow(p)` (0..1), meshed and kept where it grows."""
    f = heads.field(S)

    def fm(p):
        # The volume thins out over the last centimetre and a half to the
        # hairline, so the hair ends on the skin and not on a ledge.
        return f(p) - thickness(p) * np.clip(grow(p, soft=0.03) * 1.2 - 0.2, 0.0, 1.0)
    obj = heads.mesh_field(fm, name, (0.0, 0.006, -0.010), level=6,
                           keep=lambda p: grow(p) > 0.35, target=target, mat="hair")
    co = np.array([v.co[:] for v in obj.data.vertices])
    n = heads.grad(fm, co)
    ao = heads.occlusion(fm, co, n, reach=0.01)
    c = shade * (0.75 + 0.25 * ao)
    heads.set_colors(obj, np.stack([c, c, c], 1))
    return obj, fm


class Lock:
    """One lock's path and its size."""

    def __init__(self, pts, width, thick, shade, curl=0.0, taper=0.6):
        self.taper = taper
        self.pts = pts
        self.width = width
        self.thick = thick
        self.shade = shade
        self.curl = curl


def grow_lock(fm, fcoll, root, direction, flow, length, step=0.008, hug=0.0035, fall=0.0,
              rnd=None, scalp=None):
    """A lock's path from `root` along `direction`, turned by `flow(p)` (the
    style's direction at a point) and pulled down by `fall` per step once off
    the head; kept `hug` outside the mass while it lies on it and outside
    `fcoll` (neck, shoulders) when it hangs."""
    rnd = rnd or random
    p = np.array(root, float)
    d = np.array(direction, float)
    d /= np.linalg.norm(d)
    pts = [p.copy()]
    n_steps = max(2, int(length / step))
    wob = np.array([rnd.uniform(-1, 1), rnd.uniform(-1, 1), 0.0]) * 0.15
    for k in range(n_steps):
        q = p[None, :]
        dist = float(fm(q)[0])
        nrm = heads.grad(fm, q)[0]
        # On the head only where hair grows: below the skull the neck is not
        # something hair lies on, and hair that followed it wrapped round
        # the throat into a rope.
        on = dist < 0.012 and (scalp is None or float(scalp(q)[0]) > 0.2)
        want = np.array(flow(p), float)
        if on:
            # Lying on the head: follow the style, in the tangent plane.
            d = d * 0.55 + want * 0.45
            d = d - nrm * min(0.0, float(d @ nrm)) - nrm * float(d @ nrm) * 0.9
        else:
            # Hanging: down, and out from the head the way it grew, so a
            # curtain spreads over the back and the shoulders instead of
            # gathering into a rope under the skull.
            out = np.array([p[0], p[1] - 0.012, 0.0])
            out /= max(1e-9, np.linalg.norm(out))
            d = d * 0.75 + (out * 0.12 + np.array([0.0, 0.0, -1.0])) * fall
        d = d + wob * 0.2
        d /= max(1e-9, np.linalg.norm(d))
        p = p + d * step
        # Onto the mass while it faces up enough to hold the hair -- a step
        # along the tangent of a convex head leaves it, and fifty of them
        # left the locks standing off it like shingles -- and never into it.
        q = p[None, :]
        dist = float(fm(q)[0])
        n2 = heads.grad(fm, q)[0]
        if dist < hug or (on and dist < 0.012 and n2[2] > -0.15):
            p = p - n2 * (dist - hug)
        q = p[None, :]
        dc = float(fcoll(q)[0])
        if dc < hug + 0.004:
            p = p + heads.grad(fcoll, q)[0] * (hug + 0.004 - dc)
        pts.append(p.copy())
    return pts


def lock_mesh(locks, fm, name, root_dark=0.62, tip_light=1.08):
    """Every lock as a tapered, flattened strand: across the head it is its
    width, off it its thickness, arched a little so its middle stands proud
    of its edges and the light rolls over it."""
    verts, faces, cols = [], [], []
    for L in locks:
        pts = np.array(L.pts)
        n = len(pts)
        if n < 2:
            continue
        base = len(verts)
        tang = np.gradient(pts, axis=0)
        tang /= np.maximum(np.linalg.norm(tang, axis=1)[:, None], 1e-9)
        nrm = heads.grad(fm, pts)
        for i in range(n):
            t = i / (n - 1)
            T = tang[i]
            N = nrm[i] - T * float(nrm[i] @ T)
            N /= max(1e-9, np.linalg.norm(N))
            side = np.cross(T, N)
            # Full for most of its length, then narrowing to a blunt end: a
            # clump of hair, not a thorn.
            u = min(1.0, max(0.0, (t - 0.45) / 0.55))
            w = L.width * (1.0 - L.taper * u * u * (3 - 2 * u))
            h = L.thick * (1.0 - 0.8 * t)
            c = pts[i]
            if i == 0:
                c = c - N * L.thick * 0.6          # the root goes into the mass
            if L.curl:
                c = c + side * L.curl * math.sin(t * math.pi * 1.5) * w
            # Left edge, crown, right edge, and the underside.
            ring = [c - side * w * 0.5 + N * h * 0.15, c + N * h, c + side * w * 0.5 + N * h * 0.15,
                    c - N * h * 0.35]
            verts += ring
            shade = L.shade * (root_dark + (tip_light - root_dark) * min(1.0, t * 1.6))
            cols += [(shade, shade, shade)] * 2 + [(shade * 0.96,) * 3, (shade * 0.7,) * 3]
        for i in range(n - 1):
            a, b = base + i * 4, base + (i + 1) * 4
            for k in range(4):
                k2 = (k + 1) % 4
                faces.append((a + k, a + k2, b + k2, b + k))
        # Close the root and the tip.
        faces.append((base + 3, base + 2, base + 1, base + 0))
        last = base + (n - 1) * 4
        faces.append((last, last + 1, last + 2, last + 3))
    return _mesh(name, verts, faces, cols)


def resample(pts, spacing=0.002):
    """A path resampled at an even spacing, so a lock's ridge is a ridge and
    not a string of beads."""
    pts = np.array(pts)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    n = max(2, int(s[-1] / spacing) + 1)
    u = np.linspace(0.0, s[-1], n)
    return np.stack([np.interp(u, s, pts[:, k]) for k in range(3)], 1)


def sculpt(fm, grow, locks, name, target, shade=0.95, level=7):
    """The mass with the locks that lie on it sculpted into it: each lock
    raises a rounded ridge along its path, full at the root and easing off to
    the tip, and where no lock lies the mass stays low -- so the head of hair
    is one surface with clumps and the grooves between them, which is what
    sculpted hair is and what a shell with a colour on it is not."""
    from mathutils.kdtree import KDTree
    obj = heads.mesh_field(fm, name, (0.0, 0.006, -0.010), level=level,
                           keep=lambda p: grow(p) > 0.35, target=None, mat="hair")
    me = obj.data
    co = np.array([v.co[:] for v in me.vertices])
    nrm = heads.grad(fm, co)
    pts, info = [], []
    for li, L in enumerate(locks):
        path = resample(L.pts)
        m = len(path)
        for i in range(m):
            pts.append(path[i])
            info.append((li, i / max(1, m - 1)))
    kd = KDTree(len(pts))
    for i, p in enumerate(pts):
        kd.insert(p, i)
    kd.balance()
    reach = max(L.width for L in locks) * 0.6
    hmax = max(L.thick for L in locks) * 1.5
    disp = np.zeros(len(co))
    tone = np.zeros(len(co))
    for vi in range(len(co)):
        per = {}
        for (_, idx, d) in kd.find_range(co[vi], reach):
            li, t = info[idx]
            L = locks[li]
            w = L.width * 0.5 * (1.0 - 0.4 * t)
            if d >= w:
                continue
            h = L.thick * 1.5 * (1.0 - 0.45 * t) * (1.0 - (d / w) ** 2) ** 1.5
            if h > per.get(li, 0.0):
                per[li] = h
        # Where clumps overlap they merge rather than stack: a soft union,
        # so two locks side by side are one wider clump with a groove only
        # where they part.
        keep = 1.0
        acc, wsum = 0.0, 0.0
        for li, h in per.items():
            keep *= 1.0 - min(0.95, h / hmax)
            acc += locks[li].shade * h
            wsum += h
        disp[vi] = hmax * (1.0 - keep)
        tone[vi] = acc / wsum if wsum > 0 else 0.8
    disp *= np.clip(grow(co, soft=0.02) * 1.3 - 0.15, 0.0, 1.0)
    for v, c, n_, d in zip(me.vertices, co, nrm, disp):
        v.co = c + n_ * d
    top = max(1e-6, disp.max())
    k = np.clip(disp / (top * 0.6), 0.0, 1.0)
    c = shade * tone * (0.50 + 0.50 * k)
    heads.set_colors(obj, np.stack([c, c, c], 1))
    if target:
        dm = obj.modifiers.new("decimate", "DECIMATE")
        me.calc_loop_triangles()
        dm.ratio = min(1.0, target / max(1, len(me.loop_triangles)))
        dm.use_collapse_triangulate = True
        heads._apply(obj)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def free_locks(locks, fm, grow, off=0.0025):
    """The parts of the locks that leave the mass -- a fringe over the brow,
    the ends over the ears and the nape, whatever hangs -- as locks of their
    own, starting a little back on the mass so they grow out of it."""
    out = []
    for L in locks:
        path = np.array(L.pts)
        d = fm(path)
        gr = grow(path)
        free = (d > off) | (gr < 0.35)
        if not free.any():
            continue
        first = int(np.argmax(free))
        start = max(0, first - 2)
        if len(path) - start < 2:
            continue
        part = path[start:]
        # Hanging hair is a long straight fall: a vertex every two centimetres
        # carries its line, and a lock a centimetre apart spent triangles on
        # nothing but the budget.
        if len(part) > 4:
            part = resample(part, 0.02)
        out.append(Lock(list(part), L.width * (0.9 if start else 1.0), L.thick, L.shade, L.curl,
                        taper=0.45))
    return out


def sample_roots(fm, grow, n, seed, min_gap, region=None):
    """Roots spread evenly over where the hair grows, on the mass: points on
    a dense sphere projected to it, thinned by a minimum spacing."""
    rnd = random.Random(seed)
    k = 4000
    i = np.arange(k) + 0.5
    phi = np.arccos(1 - 2 * i / k)
    th = math.pi * (1 + 5 ** 0.5) * i
    dirs = np.stack([np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)], 1)
    pts = heads.project(fm, (0.0, 0.006, -0.010), dirs)
    ok = grow(pts) > 0.6
    if region is not None:
        ok &= region(pts)
    pts = pts[ok]
    order = list(range(len(pts)))
    rnd.shuffle(order)
    chosen = []
    for j in order:
        p = pts[j]
        if all(np.linalg.norm(p - c) > min_gap for c in chosen):
            chosen.append(p)
        if len(chosen) >= n:
            break
    return chosen, rnd


def clear_of_face(pts):
    """A lock stops where it would hang in front of the eyes or the mouth."""
    for i, p in enumerate(pts):
        if p[1] < -0.045 and p[2] < 0.030 and abs(p[0]) < 0.066:
            return pts[:max(2, i)]
    return pts


def tangent(fm, p, d):
    nrm = heads.grad(fm, np.array([p]))[0]
    d = np.array(d, float) - nrm * float(np.dot(d, nrm))
    return d / max(1e-9, np.linalg.norm(d))


# --- styles -------------------------------------------------------------------

def _finish(S, P, parts, name, face_weights=False):
    """Into the body's head frame, joined, on the head bone (or, for what
    grows on the face, weighted with the jaw like the skin under it)."""
    import people
    for o in parts:
        co = np.array([v.co[:] for v in o.data.vertices])
        w, _ = heads.to_world(P, co)
        for v, x in zip(o.data.vertices, w):
            v.co = x
    obj = people.join(parts, name)
    obj.data.name = name
    if face_weights:
        heads.rig_weights(obj, P)
    else:
        rig.set_rigid(obj, "head")
    return obj


def _thick(top, side, back):
    def t(p):
        z = np.clip((p[:, 2] - 0.02) / 0.09, 0, 1)
        b = np.clip(p[:, 1] / 0.08, 0, 1)
        return side + (top - side) * z + (back - side) * b * (1 - z)
    return t


def style_short(S, P, name="hair_short", seed=3):
    """A man's short hair: out from the whorl on the crown, a short fringe
    forward over the brow, trimmed round the ears and the nape."""
    grow = lambda p, soft=0.004: scalp_mask(p, soft=soft)
    fm_obj, fm = mass(S, name + "_mass", _thick(0.008, 0.004, 0.006), grow, target=420)
    fcoll = body_field(S)
    whorl = np.array([0.012, 0.060, 0.108])

    def flow(p):
        d = p - whorl
        d[2] -= 0.02
        return tangent(fm, p, d)
    roots, rnd = sample_roots(fm, grow, 80, seed, 0.013)
    locks = []
    for r in roots:
        # Each lock runs with the comb from where it grows to the edge of the
        # hair and a little past it: long enough that the ridges carry across
        # the head as lines, short enough that past the hairline it is a
        # fringe and not a curtain.
        pts = grow_lock(fm, fcoll, r, flow(r), flow, 0.16, step=0.006, hug=0.0004, rnd=rnd)
        gr = grow(np.array(pts))
        out = np.nonzero(gr < 0.35)[0]
        end = int(out[0]) + rnd.randint(1, 3) if len(out) else len(pts)
        pts = pts[:max(3, end)]
        locks.append(Lock(pts, rnd.uniform(0.020, 0.028), rnd.uniform(0.0045, 0.0058),
                          rnd.uniform(0.82, 1.14)))
    bpy.data.objects.remove(fm_obj, do_unlink=True)
    body = sculpt(fm, grow, locks, name + "_mass", target=2200)
    return _finish(S, P, [body], name)


def style_crop(S, P, name="hair_crop", seed=5):
    """Cropped close: a thin mass with a fine nap of short ridges."""
    grow = lambda p, soft=0.004: scalp_mask(p, recede=0.3, soft=soft)
    fm_obj, fm = mass(S, name + "_mass", _thick(0.004, 0.0025, 0.003), grow, target=380, shade=0.6)
    fcoll = body_field(S)
    whorl = np.array([0.0, 0.070, 0.100])

    def flow(p):
        return tangent(fm, p, p - whorl)
    roots, rnd = sample_roots(fm, grow, 110, seed, 0.010)
    locks = []
    for r in roots:
        pts = grow_lock(fm, fcoll, r, flow(r), flow, rnd.uniform(0.020, 0.030), step=0.005, hug=0.0003,
                        rnd=rnd, scalp=grow)
        locks.append(Lock(pts, rnd.uniform(0.012, 0.016), 0.0018, rnd.uniform(0.9, 1.08)))
    bpy.data.objects.remove(fm_obj, do_unlink=True)
    body = sculpt(fm, grow, locks, name + "_mass", target=1300)
    return _finish(S, P, [body], name)


def style_long(S, P, name="hair_long", seed=7, length=0.22, part=0.0):
    """Hair to the shoulders or past them, parted: from the parting over the
    crown and down both sides, framing the face and falling on the back.
    On the head it is sculpted into the mass; where it leaves the head it
    hangs as locks, wide and overlapping, a curtain rather than a fringe."""
    grow = lambda p, soft=0.004: scalp_mask(p, soft=soft)
    fm_obj, fm = mass(S, name + "_mass", _thick(0.010, 0.007, 0.009), grow, target=500)
    fcoll = body_field(S)

    def flow(p):
        x, y, z = p
        side = 1.0 if x - part >= 0 else -1.0
        # Away from the parting over the top, then down; at the back, down;
        # and at the front swept back over the temples, so the hair frames
        # the face instead of hanging in front of the eyes.
        d = np.array([side * max(0.0, z - 0.02) * 10.0,
                      max(0.0, y) * 3.0 + 0.2 + 25.0 * max(0.0, -0.035 - y), -1.0])
        return tangent(fm, p, d)
    roots, rnd = sample_roots(fm, grow, 90, seed, 0.011)
    locks = []
    for r in roots:
        # Longest at the back, shortest over the brow and the temples.
        back = np.clip((r[1] + 0.03) / 0.10, 0.0, 1.0)
        L = length * (0.6 + 0.4 * back) * rnd.uniform(0.88, 1.08)
        if r[1] < -0.050 and r[2] > 0.035:
            L = rnd.uniform(0.07, 0.10)        # the front, swept to the side
        pts = grow_lock(fm, fcoll, r, flow(r), flow, L, step=0.010, hug=0.0006, fall=0.35, rnd=rnd,
                        scalp=grow)
        pts = clear_of_face(pts)
        locks.append(Lock(pts, rnd.uniform(0.034, 0.044), rnd.uniform(0.0045, 0.006),
                          rnd.uniform(0.84, 1.12), curl=rnd.uniform(-0.2, 0.2)))
    bpy.data.objects.remove(fm_obj, do_unlink=True)
    parts = [sculpt(fm, grow, locks, name + "_mass", target=1800)]
    loose = free_locks(locks, fm, grow, off=0.004)
    if loose:
        parts.append(lock_mesh(loose, fcoll, name + "_locks", root_dark=0.85))
    return _finish(S, P, parts, name)


def style_back(S, P, name, gather, seed=11, extra=()):
    """Hair drawn back to a point -- a bun, a tail, a braid -- lying close
    over the head in locks that all run to `gather`."""
    grow = lambda p, soft=0.004: scalp_mask(p, soft=soft)
    fm_obj, fm = mass(S, name + "_mass", _thick(0.006, 0.004, 0.005), grow, target=460)
    fcoll = body_field(S)
    gp = np.array(gather)

    def flow(p):
        return tangent(fm, p, gp - p)
    roots, rnd = sample_roots(fm, grow, 70, seed, 0.012)
    locks = []
    for r in roots:
        L = float(np.linalg.norm(gp - r)) * 1.1
        pts = grow_lock(fm, fcoll, r, flow(r), flow, L, step=0.008, hug=0.0004, rnd=rnd, scalp=grow)
        locks.append(Lock(pts, rnd.uniform(0.018, 0.024), rnd.uniform(0.0030, 0.0040), rnd.uniform(0.86, 1.1)))
    bpy.data.objects.remove(fm_obj, do_unlink=True)
    body = sculpt(fm, grow, locks, name + "_mass", target=1600)
    return fm, fcoll, rnd, [body] + list(extra)


def _knot(center, radii, name, turns=3, rnd=None, shade=0.9):
    """A bun: a coil of thick locks wound round a centre."""
    locks = []
    c = np.array(center)
    for k in range(turns):
        pts = []
        for i in range(24):
            a = 2 * math.pi * (i / 24.0) * 1.1 + k * 2.1
            rr = 1.0 - 0.28 * k
            pts.append(c + np.array([math.cos(a) * radii[0] * rr, math.sin(a) * radii[1] * 0.5 * rr + 0.004 * k,
                                     math.sin(a) * radii[2] * rr]))
        locks.append(Lock(pts, 0.020 - 0.004 * k, 0.010 - 0.002 * k, shade))
    return locks


def style_bun(S, P, name="hair_bun", seed=13):
    center = (0.0, 0.122, 0.030)
    fm, fcoll, rnd, parts = style_back(S, P, name, (0.0, 0.100, 0.032), seed)
    ball = lambda p: heads.ell(p, center, (0.032, 0.026, 0.030))
    locks = _knot(center, (0.028, 0.024, 0.026), name, rnd=rnd)
    parts.append(lock_mesh(locks, ball, name + "_knot", root_dark=0.8))
    return _finish(S, P, parts, name)


def style_braid(S, P, name="hair_braid", seed=17, length=0.30):
    """Drawn back and plaited into one braid down the back: the plait is a
    chain of lobes, left and right in turn, tapering to a tie."""
    fm, fcoll, rnd, parts = style_back(S, P, name, (0.0, 0.090, -0.030), seed)
    locks = []
    top = np.array([0.0, 0.098, -0.030])
    n = 12
    for i in range(n):
        t = i / n
        z = top[2] - length * t
        # The braid lies on the back: it follows the collision field down.
        y = top[1] + 0.012 * math.sin(t * 2.0) + 0.02 * t
        p = np.array([0.0, y, z])
        dc = float(fcoll(p[None, :])[0])
        if dc < 0.012:
            p = p + heads.grad(fcoll, p[None, :])[0] * (0.012 - dc)
        side = 1 if i % 2 else -1
        w = 0.030 * (1.0 - 0.45 * t)
        a = p + np.array([side * w * 0.35, 0.0, 0.010])
        b = p + np.array([-side * w * 0.25, 0.004, -length / n * 0.9])
        locks.append(Lock([a, (a + b) / 2 + np.array([0, 0.004, 0]), b], w, w * 0.4, rnd.uniform(0.9, 1.05)))
    parts.append(lock_mesh(locks, fcoll, name + "_plait", root_dark=0.85))
    return _finish(S, P, parts, name)


def style_tail(S, P, name="hair_tail", seed=19, length=0.22):
    """Drawn back to a tail at the crown's back, tied, and hanging."""
    tie = np.array([0.0, 0.100, 0.020])
    fm, fcoll, rnd, parts = style_back(S, P, name, tie, seed)
    locks = []
    for k in range(9):
        a = 2 * math.pi * k / 9
        r = tie + np.array([math.cos(a) * 0.008, 0.004 + math.sin(a) * 0.004, 0.0])
        pts = grow_lock(fcoll, fcoll, r, (0, 0.5, -1), lambda p: np.array([0, 0.15, -1.0]),
                        length * rnd.uniform(0.85, 1.1), step=0.014, hug=0.004, fall=0.5, rnd=rnd)
        locks.append(Lock(pts, 0.016, 0.006, rnd.uniform(0.88, 1.06), curl=rnd.uniform(-0.2, 0.2)))
    parts.append(lock_mesh(locks, fcoll, name + "_tail"))
    tie_ring = heads.mesh_field(lambda p: heads.ell(p, tie, (0.012, 0.010, 0.008)), name + "_tie",
                                tuple(tie), level=3, target=80)
    heads.set_colors(tie_ring, np.full((len(tie_ring.data.vertices), 3), 0.5))
    parts.append(tie_ring)
    return _finish(S, P, parts, name)


def style_fringe(S, P, name="hair_fringe", seed=23):
    """Bald on top, a fringe round the back and sides: a monk's, or an old
    man's."""
    def grow(p, soft=0.004):
        # The fringe's top edge rises from the temples to the back of the
        # skull, as a balding man's does. Level all round at 5 cm, it was a
        # dark band at eye height that a judge took for a blindfold.
        back = np.clip((np.abs(np.degrees(theta_of(p))) - 90) / 70, 0, 1)
        top = np.clip((0.050 + 0.030 * back - p[:, 2]) / max(soft, 0.008), 0, 1)
        sides = np.clip((np.abs(np.degrees(theta_of(p))) - 55) / 8, 0, 1)
        return scalp_mask(p, soft=soft) * top * sides
    fm_obj, fm = mass(S, name + "_mass", _thick(0.006, 0.006, 0.007), grow, target=300)
    fcoll = body_field(S)

    def flow(p):
        return tangent(fm, p, np.array([0.0, 0.2, -1.0]))
    roots, rnd = sample_roots(fm, grow, 50, seed, 0.011)
    locks = []
    for r in roots:
        pts = grow_lock(fm, fcoll, r, flow(r), flow, rnd.uniform(0.03, 0.045), step=0.006, hug=0.0004,
                        rnd=rnd, scalp=grow)
        locks.append(Lock(pts, rnd.uniform(0.016, 0.022), 0.0038, rnd.uniform(0.88, 1.08)))
    bpy.data.objects.remove(fm_obj, do_unlink=True)
    body = sculpt(fm, grow, locks, name + "_mass", target=1100)
    return _finish(S, P, [body], name)


# --- beards -------------------------------------------------------------------

def beard_region(S, kind):
    """Where a beard grows, as a soft 0..1: the upper lip, the chin, the jaw
    back to its angle, the cheek below a line from the sideburn to the corner
    of the mouth, and under the chin to the top of the throat -- and not the
    lips, the neck or the back of the jaw."""
    lz = S["mouth_z"]

    def r(p, soft=None):
        x, y, z = np.abs(p[:, 0]), p[:, 1], p[:, 2]
        th = np.degrees(np.abs(theta_of(p)))
        k = max(1.0, (soft or 0.004) / 0.004)
        sm = lambda v, a: np.clip(v / (a * k) + 0.5, 0.0, 1.0)
        if kind == "moustache":
            m = sm(0.030 - x, 0.004) * sm(z - (lz + 0.003), 0.003) * sm((lz + 0.021) - z, 0.004) * sm(38 - th, 6)
            return m
        # The cheek line: up by the ear to meet the sideburn, down to the
        # corner of the mouth.
        cheek = 0.004 - 0.044 * np.clip((0.068 - x) / 0.048, 0, 1) ** 0.8
        m = sm(cheek - z, 0.005)
        # Not behind the angle of the jaw, not down the neck.
        m *= sm(0.018 - y, 0.008) * sm(z + (0.128 if kind == "full" else 0.122), 0.006)
        # Clear of the lips; a trimmed beard also clear under the lower lip.
        # An oval, not a box: the mouth shows through the beard as lips.
        e = (x / 0.025) ** 2 + ((z - (lz - 0.002)) / 0.0085) ** 2
        lips = np.clip((1.0 - e) / 0.35 + 0.5, 0.0, 1.0)
        m *= 1.0 - lips
        if kind == "short":
            m *= 1.0 - sm(0.010 - x, 0.004) * sm(z - (lz - 0.018), 0.004) * sm((lz - 0.006) - z, 0.004)
        return m
    return r


def style_beard(S, P, name, kind, seed=29):
    """A beard: its mass on the jaw, the chin and the upper lip, sculpted
    with locks that fall down and a little forward off the chin, and for a
    full one the ends hanging free below it."""
    region = beard_region(S, kind)

    def grow(p, soft=None):
        return region(p, soft)

    def thick(p):
        z = p[:, 2]
        if kind == "full":
            # Heavier to the chin and hanging below it.
            return 0.006 + 0.016 * np.clip((-0.07 - z) / 0.045, 0, 1)
        if kind == "moustache":
            return np.full(len(p), 0.0045)
        return np.full(len(p), 0.0032)
    fm_obj, fm = mass(S, name + "_mass", thick, grow, target=320 if kind != "moustache" else 90, shade=0.5)
    fcoll = body_field(S)

    def flow(p):
        x = p[0]
        if kind == "moustache":
            return tangent(fm, p, np.array([np.sign(x) * 0.9, -0.1, -1.0]))
        return tangent(fm, p, np.array([np.sign(x) * 0.08, -0.3, -1.0]))
    count = {"full": 70, "short": 70, "moustache": 16}[kind]
    gap = {"full": 0.009, "short": 0.008, "moustache": 0.005}[kind]
    roots, rnd = sample_roots(fm, grow, count, seed, gap)
    locks = []
    for r in roots:
        chin = float(np.clip((-0.07 - r[2]) / 0.04, 0, 1))
        if kind == "full":
            L = rnd.uniform(0.030, 0.040) + 0.03 * chin
            pts = grow_lock(fm, fcoll, r, flow(r), flow, L, step=0.006, hug=0.0004, rnd=rnd, scalp=grow)
            locks.append(Lock(pts, rnd.uniform(0.014, 0.020), 0.0045, rnd.uniform(0.85, 1.1),
                              curl=rnd.uniform(-0.2, 0.2)))
        elif kind == "short":
            pts = grow_lock(fm, fcoll, r, flow(r), flow, rnd.uniform(0.014, 0.020), step=0.004, hug=0.0003,
                            rnd=rnd, scalp=grow)
            locks.append(Lock(pts, rnd.uniform(0.010, 0.013), 0.0020, rnd.uniform(0.9, 1.06)))
        else:
            pts = grow_lock(fm, fcoll, r, flow(r), flow, rnd.uniform(0.020, 0.028), step=0.004, hug=0.0004,
                            rnd=rnd, scalp=grow)
            locks.append(Lock(pts, rnd.uniform(0.009, 0.012), 0.0030, rnd.uniform(0.9, 1.05)))
    bpy.data.objects.remove(fm_obj, do_unlink=True)
    parts = [sculpt(fm, grow, locks, name + "_mass", target={"full": 1400, "short": 900, "moustache": 300}[kind],
                    level=7)]
    return _finish(S, P, parts, name, face_weights=True)
