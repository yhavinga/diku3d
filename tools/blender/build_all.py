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
    "hood",
    "townsperson",
    "weapons",
    "people",
    "beasts",
    "monsters",
    "creatures",
    "fauna",
    "hybrids",
    "furniture",
    "clutter",
    "setpiece",
    "statues",
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
    # Clipped hedge: leaf cards over a rounded box, one knot at a Shire lane
    # corner and two along a hedgebank -- a tree's worth of foliage each.
    "hedge_clump": 2200, "hedge_row": 2200,
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
    # The Dangerous Neighborhood. The two houses are fillers like the town's
    # own and are held to the same cap; the ruin panels are room-kit pieces.
    # The heaps and wrecks are single props seen close in No Man's Land, a
    # dozen or two of each in the whole district; the bramble is scattered
    # over the overgrown lot and the park and is the one to watch.
    "house_derelict": 7000, "house_gutted": 7000,
    "ruin_wall_solid": 2000, "ruin_wall_door": 2000, "ruin_wall_breach": 2100, "ruin_corner": 600,
    "rubble_heap": 1800, "barricade": 1800, "burnt_cart": 1900, "khan_memorial": 2500,
    "dracolich_idol": 1800, "bramble": 1700, "collapsed_shed": 1100, "broken_stair": 900,
    "debris": 800, "city_wall": 1500,
    # Carried, so paid for once per armed mobile and once more in first person.
    "weapon_sword": 600, "weapon_dagger": 400, "weapon_axe": 500, "weapon_mace": 600,
    "weapon_spear": 400, "weapon_staff": 500, "shield_round": 1100, "shield_kite": 1000,
    # The animals. One skinned mesh each, two materials (fur or feathers, and
    # horn), and far fewer of them than of people: Midgaard has 13, the
    # Shire's farm 19. The big ones get the most because they are the ones
    # seen close and whole -- a horse fills the frame a sparrow never does.
    "beast_canine": 5400, "beast_feline": 3800, "beast_rodent": 2600, "beast_bear": 5600,
    "beast_equine": 6600, "beast_cervid": 5200, "beast_bovine": 6000, "beast_pig": 4800,
    "beast_duck": 3800, "beast_swan": 4500, "beast_hen": 4000, "beast_songbird": 2600,
    "beast_snake": 3600, "beast_worm": 2600,
    # One of it in the default world, and it is nine metres long.
    "beast_dragon": 8200,
    # The conifers are bough whorls carrying folded needle cards rather than
    # stacked cones: a card is four triangles and a crown needs two hundred
    # of them to close. Instanced by the hundred, so measured, not guessed:
    # +0.3 ms at #6104 against the cones they replace.
    "tree_fir": 2500, "tree_pine": 2300, "tree_cedar": 2400,
    # monsters.py. The legged ones pay for their legs: eight of them, each a
    # separate little surface, is where a spider's triangles go.
    "beast_spider": 5000, "beast_beetle": 4600, "beast_scorpion": 4800,
    # Two in the world. Sixteen jointed, spined leg segments a side is where
    # it goes, and a sculpted face with a head of hair on top of that.
    "beast_drider": 12500,
    "beast_bat": 3400, "beast_mud": 6800, "beast_myconoid": 4400, "beast_ratman": 4600,
    "beast_imp": 4600, "beast_naga": 5600,
    # One in the world, ten metres of it seen whole: rings, plates, spines,
    # three toothed jaws and the crater it stands in.
    "beast_sandworm": 9800, "beast_basilisk": 6600,
    "beast_dustdigger": 3000, "beast_camel": 4600,
    # fauna.py: the frogs and the Rock Toad, a cow-sized one seen whole.
    "beast_frog": 3400,
    # Bones are all edges: a rib cage and a spine of knuckles do not decimate.
    "beast_dracolich": 9600,
    # hybrids.py. A taur is a whole animal and a person to the waist, with a
    # sculpted face and a head of hair: the drider's budget, which is the
    # same thing on eight legs.
    "beast_centaur": 12500, "beast_centaur_f": 12500, "beast_lamia": 12500,
    # A woman to the hips on a bird's legs, and two ragged wings of quills.
    "beast_harpy": 13000,
    # furniture.py. Tables, benches and stools are placed a dozen to a tavern
    # and stay under the prop cap. The bar, its gantry and the shelving carry
    # everything that stands on them -- bottles, jugs, loaves, books -- and are
    # one or two to a room, a few rooms in the world; the hearth, forge and
    # oven reach the ceiling.
    "furn_bar_counter": 3000, "furn_shop_counter": 2800, "furn_backbar": 4600, "furn_cask_rack": 1600,
    "furn_hearth": 1600, "furn_hearth_pot": 1900, "furn_forge": 1900, "furn_oven": 1800,
    "furn_shelves_goods": 5500, "furn_shelves_bread": 5500, "furn_shelves_jars": 5500,
    "furn_shelves_hides": 3400, "furn_weapon_rack": 1800, "furn_weapon_board": 1600,
    "furn_armour_stand": 1500, "furn_settle": 1000, "furn_armchair": 1000, "furn_desk": 1100,
    # clutter.py: what the prose puts in a room, one to a handful of each per
    # room that names it and none anywhere else. A skeleton is all thin
    # members -- ribs, fingers, the long bones -- and does not decimate; a
    # painting's picture is its vertex colours, so its grid is its detail.
    "clutter_bones": 3000, "clutter_skeleton": 3500, "clutter_skeleton_seated": 3500,
    "clutter_skeleton_hanging": 4400, "clutter_shackles": 3000, "clutter_strongbox": 1200,
    "clutter_hoard": 2600, "clutter_sarcophagus": 1500, "clutter_alchemy": 3600,
    "clutter_painting_portrait": 2100, "clutter_painting_landscape": 2600, "clutter_painting_gathering": 3000,
    "clutter_mural": 4000, "clutter_arms": 2000, "clutter_tapestry": 3100, "clutter_web": 2600,
    "clutter_cages": 1600, "clutter_globe": 900, "clutter_feast": 4100, "clutter_carcass": 2500,
    "clutter_pelts": 2000,
    # setpiece.py: one of each in the world, or four gatehouses. The fortress
    # is a whole castle seen from a hundred metres.
    "gatehouse": 6000, "fortress": 20000, "monolith": 400, "statue_worm": 7000,
    # statues.py. One Odin in the world (two with the mirror Midgaard), seen
    # from three metres at the altar: the face and beard are carved on a 5 mm
    # grid of their own, and a pair each of wolves and ravens sit on it.
    "statue_odin": 60000, "altar_marble": 1600, "relief_face": 2500, "altar_faces": 6800,
    # The firedeath's fire, a dozen lengths of it round one room.
    "fire_bed": 2500,
    # One each: the sewer's imp and its dragons on the lair's table, carved
    # small and seen close; the Shire watermill's stones and gearing.
    "statue_imp": 9500, "figurine_dragons": 6800, "millstones": 2400,
}
PROP_BUDGET = 800
# people.py: an archetype is a whole dressed person, one skinned draw per
# material; a head piece is worn on top of one. Figures are culled at 46 m
# and a busy square shows about a dozen, so these are paid perhaps twelve
# times a frame, not per chunk.
PERSON_BUDGET = 6500
# Hoods, coifs and scarves are cut from the sculpted skull, which is denser
# than the ring-stack it replaced.
HEAD_PIECE_BUDGET = 1600
# A face is the skin with the ears, two eyeballs and the brows: the part of a
# person that is looked at hardest, and so the densest.
FACE_BUDGET = 3800
# Hair in locks: the sculpted mass and, for long hair, the fall. A woman's
# hair to her shoulders is most of what reads of her at twenty metres, so it
# is paid for; everything else on a head stays under the old cap.
# A troll's face carries its own ragged hair, its tusks and pointed ears --
# there are no head pieces in the troll file -- and an ettin's is two of it.
HAIR_BUDGET = {"hair_long": 8000, "turban": 1200, "face_troll": 6500, "face_ettin": 13000, "hair_braid": 3000, "hair_bun": 3000, "hair_tail": 3500,
               "hair_short": 2600, "hair_crop": 1600, "hair_fringe": 1400, "beard_full": 1800,
               "beard_short": 1200, "moustache": 400}
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
        cap = BUDGET.get(name) or HAIR_BUDGET.get(name) or (TREE_BUDGET if name.startswith("tree") else
                         PERSON_BUDGET if name.startswith("arch_") else
                         FACE_BUDGET if name.startswith("face_") else
                         HEAD_PIECE_BUDGET if name.startswith(("hair_", "beard_", "helm_", "hat_",
                                                               "hood", "coif", "scarf", "moustache"))
                         else PROP_BUDGET)
        if tris > cap:
            bad.append("%s %d > %d" % (name, tris, cap))
    return "OVER BUDGET: " + ", ".join(bad) if bad else "all within budget"
