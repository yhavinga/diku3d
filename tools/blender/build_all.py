"""Rebuild the whole asset library from source, in order.

Run it from inside Blender -- the models are built by script, so this file plus
the modules it names is the only source there is:

    import sys, importlib, traceback
    sys.path.insert(0, "/Users/yeb/Developer/yhavinga/diku3d/tools/blender")
    import build_all; importlib.reload(build_all)
    try: print(build_all.run())
    except Exception: print(traceback.format_exc())

Each module exposes build() -> a one-line report, and writes assets/<name>.glb.
props and trees hold several small assets each and expose build() that runs the
lot; everything else is one asset per module.
"""

import importlib
import traceback

import lib
import kit

MODULES = [
    "house_a",
    "house_b",
    "house_c",
    "house_stone_a",
    "house_stone_b",
    "temple",
    "props",
    "trees",
    "townsperson",
]

# What each one is allowed to cost. The town instances all of these, so a
# regression here is multiplied by however many of them Midgaard ends up with.
BUDGET = {
    "house_a": 4000, "house_b": 4000, "house_c": 4000,
    "house_stone_a": 4000, "house_stone_b": 4000,
    "temple": 8000, "townsperson": 3000,
}
PROP_BUDGET = 800
TREE_BUDGET = 1500


def run(only=None):
    importlib.reload(lib)
    importlib.reload(kit)
    out = []
    for name in MODULES:
        if only and name not in only:
            continue
        try:
            mod = importlib.import_module(name)
            importlib.reload(mod)
            out.append(mod.build())
        except Exception:
            out.append("%-16s FAILED\n%s" % (name, traceback.format_exc()))
    report = "\n".join(out)
    return report + "\n" + check(report)


def preview(names, cols=6, pitch=3.4, human_every=0):
    """Import finished .glb files back into an empty scene and lay them out in a
    grid. Reading the exported file rather than the scene that made it is the
    only check that what the viewer will load is what was modelled."""
    import bpy
    import os
    lib.reset()
    for i, name in enumerate(names):
        path = os.path.join(lib.ASSETS, "%s.glb" % name)
        if not os.path.exists(path):
            continue
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        dx = (i % cols - (cols - 1) / 2.0) * pitch
        dy = (i // cols) * -pitch
        for obj in set(bpy.context.scene.objects) - before:
            if obj.parent is None:
                obj.location.x += dx
                obj.location.y += dy
        if human_every and i % human_every == 0:
            kit.human(dx - pitch * 0.36, dy - pitch * 0.3)
    return "previewing %d" % len(names)


def check(report):
    """Read the triangle counts back out of the report and flag any overrun."""
    bad = []
    for line in report.splitlines():
        bits = line.split()
        if len(bits) < 3 or bits[2] != "tris":
            continue
        name, tris = bits[0], int(bits[1])
        cap = BUDGET.get(name, TREE_BUDGET if name.startswith("tree") else PROP_BUDGET)
        if tris > cap:
            bad.append("%s %d > %d" % (name, tris, cap))
    return "OVER BUDGET: " + ", ".join(bad) if bad else "all within budget"
