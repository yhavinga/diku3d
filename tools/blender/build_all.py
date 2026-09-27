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
    "roomkit",
    "props",
    "trees",
    "marsh",
    "townsperson",
    "weapons",
]

# What each one is allowed to cost. The town instances all of these, so a
# regression here is multiplied by however many of them Midgaard ends up with.
BUDGET = {
    # Raised from 4000 when the houses were reworked for relief. Recessed
    # reveals, sills with drips, shutters, rafter tails, plinths, string
    # courses and braced jetties are all geometry, and geometry is the only
    # thing that casts a shadow -- a flat wall with a texture on it cost 4000
    # and read as printed.
    "house_a": 7000, "house_b": 7000, "house_c": 7000,
    "house_stone_a": 7000, "house_stone_b": 7000,
    "temple": 8000, "townsperson": 3000,
    # roomkit. These are instanced per wall rather than per building, so a room
    # costs four panels plus four piers plus a roof -- read the caps as a sixth
    # of a building each, not as one.
    "temple_wall_solid": 2500, "temple_wall_door": 2500, "temple_corner": 600,
    "temple_roof": 4000, "temple_steps": 400, "temple_column": 600,
    "wall_solid": 2000, "wall_door": 2000, "wall_corner": 600, "wall_roof": 3000,
    # A whole building rather than a prop: four log walls, two log gables and a
    # shake roof. It lives in props.py because that is where it is built, not
    # because it costs what a barrel does.
    "log_cabin": 3500,
    # The graveyard three, capped at what they were briefed at rather than left
    # to PROP_BUDGET's 800. A headstone gets scattered by the dozen and a fence
    # by the segment, so the loose cap would not have caught a regression here.
    "headstone": 250, "grave_slab": 120, "iron_fence": 450,
    # Carried, so paid for once per armed mobile and once more in first person.
    "weapon_sword": 600, "weapon_dagger": 400, "weapon_axe": 500, "weapon_mace": 600,
    "weapon_spear": 400, "weapon_staff": 500, "shield_round": 1100, "shield_kite": 1000,
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
