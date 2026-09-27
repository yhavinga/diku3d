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
    "sewer",
    "desert",
    "townsperson",
    "weapons",
    "people",
    "beasts",
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
    # The sewer kit. Like the room kit these are pieces of a building, one per
    # cell side, so read them against a wall panel's 2000 rather than a prop's
    # 800: a chamber is a groin vault, four piers and two ribs; a tunnel is a
    # whole 13 m cell of barrel vault with its floor, and is cheap because it
    # is one sweep.
    "sewer_tunnel": 600, "sewer_arm": 700, "sewer_hub": 1200, "sewer_hub_end": 300,
    "sewer_chamber": 2700, "sewer_chamber_air": 2900, "sewer_shaft": 400, "sewer_grate": 400, "sewer_door_end": 300,
    "sewer_wall_open": 1000, "sewer_wall_solid": 400, "sewer_shaft_open": 1100,
    "sewer_shaft_solid": 500, "sewer_pit": 750, "town_well": 750, "sewer_ladder": 900,
    "stalagmites": 750, "stalactites": 850, "bone_pile": 900, "rubble": 550,
    "cave_rock_a": 200, "cave_rock_b": 200,
    # Rock lining over a whole wall or ceiling, at 0.3 m a face: the relief has
    # to hold up at arm's length under a torch, which a coarser grid did not.
    "cave_wall": 1400, "cave_wall_door": 1200, "cave_wall_long": 1750,
    "cave_wall_long_door": 1550, "cave_roof": 1850,
    # Four of them in the whole world, all in the Dump.
    "refuse_heap": 1000, "sewer_sconce": 400,
    # The Great Eastern Desert. A massif block is a whole 13 m cell of cliff,
    # displaced at 0.7 m a face so the bedding ledges cast real shadow; there
    # are a few dozen of them. Dunes are placed by the hundred in the sand sea
    # past the rooms, so they are held under a thousand.
    "massif_a": 3800, "massif_b": 3000, "massif_mouth": 3300,
    "dune_a": 1000, "dune_b": 1000, "palm_a": 2500, "palm_b": 2500,
    "tent_roof": 2600, "tent_wall": 1000, "tent_wall_door": 900,
    "rug": 200, "cushions": 600, "hitch_line": 450, "fungus_cluster": 1300, "lantern": 400,
    # Carried, so paid for once per armed mobile and once more in first person.
    "weapon_sword": 600, "weapon_dagger": 400, "weapon_axe": 500, "weapon_mace": 600,
    "weapon_spear": 400, "weapon_staff": 500, "shield_round": 1100, "shield_kite": 1000,
    # The animals. One skinned mesh each, two materials (fur or feathers, and
    # horn), and far fewer of them than of people: Midgaard has 13, the
    # Shire's farm 19. The big ones get the most because they are the ones
    # seen close and whole -- a horse fills the frame a sparrow never does.
    "beast_canine": 4600, "beast_feline": 3800, "beast_rodent": 2600, "beast_bear": 5600,
    "beast_equine": 6000, "beast_cervid": 5200, "beast_bovine": 6000, "beast_pig": 4800,
    "beast_duck": 3800, "beast_swan": 4500, "beast_hen": 4000, "beast_songbird": 2600,
    "beast_snake": 3600, "beast_worm": 2600,
    # One of it in the default world, and it is nine metres long.
    "beast_dragon": 8000,
}
PROP_BUDGET = 800
# people.py: an archetype is a whole dressed person, one skinned draw per
# material; a head piece is worn on top of one. Figures are culled at 46 m
# and a busy square shows about a dozen, so these are paid perhaps twelve
# times a frame, not per chunk.
PERSON_BUDGET = 6500
HEAD_PIECE_BUDGET = 1000
# A face is the skin with the ears, two eyeballs and the brows: the part of a
# person that is looked at hardest, and so the densest.
FACE_BUDGET = 3800
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
        cap = BUDGET.get(name, TREE_BUDGET if name.startswith("tree") else
                         PERSON_BUDGET if name.startswith("arch_") else
                         FACE_BUDGET if name.startswith("face_") else
                         HEAD_PIECE_BUDGET if name.startswith(("hair_", "beard_", "helm_", "hat_",
                                                               "hood", "coif", "scarf", "moustache"))
                         else PROP_BUDGET)
        if tris > cap:
            bad.append("%s %d > %d" % (name, tris, cap))
    return "OVER BUDGET: " + ", ".join(bad) if bad else "all within budget"
