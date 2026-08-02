"""Shared helpers for the Blender asset scripts.

The models are built by script rather than by hand so the source of an asset is
the code, not a .blend nobody can diff. Geometry only: every object is tagged
with a material name like MAT:timber, and the viewer swaps in its own baked
material of that name at load. Blender gives us silhouettes, bevels and clean
normals; the procedural texture baker keeps giving us the surfaces.

Blender is Z-up and metres; the glTF exporter converts to three's Y-up for us.
"""

import bpy
import bmesh
import math
import os
import random

ROOT = "/Users/yeb/Developer/yhavinga/diku3d"
ASSETS = os.path.join(ROOT, "assets")

# Viewport colours only -- the real materials live in src/textures.js.
PALETTE = {
    "timber": (0.78, 0.72, 0.60, 1.0),
    "oak": (0.20, 0.12, 0.07, 1.0),
    "stonewall": (0.55, 0.52, 0.47, 1.0),
    "marble": (0.85, 0.83, 0.77, 1.0),
    "rooftile": (0.45, 0.18, 0.10, 1.0),
    "thatch": (0.52, 0.40, 0.20, 1.0),
    "planks": (0.35, 0.22, 0.12, 1.0),
    "iron": (0.12, 0.13, 0.14, 1.0),
    "cobble": (0.38, 0.36, 0.33, 1.0),
    "bark": (0.18, 0.12, 0.08, 1.0),
    "leaves": (0.16, 0.30, 0.10, 1.0),
    "cloth": (0.45, 0.16, 0.18, 1.0),
    "skin": (0.72, 0.54, 0.40, 1.0),
    "glass": (0.85, 0.72, 0.45, 1.0),
    # Added for the fountain, well, trough and grass tuft. src/textures.js
    # already bakes 'water' and 'grass' recipes, so the viewer has somewhere to
    # put both of these.
    "water": (0.18, 0.34, 0.40, 1.0),
    "grass": (0.22, 0.34, 0.12, 1.0),
}


def reset():
    """Empty scene. Called at the top of every asset.

    Actions are removed outright rather than only when unused: they are created
    with a fake user so they survive export, which means a rebuild leaves the
    old ones behind and the next one is named walk.001. The glTF exporter then
    happily writes all four into the file."""
    # Un-hide first: select_all skips anything with hide_viewport set, so a
    # hidden object survives the delete, and the next asset built on top of it
    # gets its names suffixed .001 while the old one sits there invisibly.
    for obj in bpy.data.objects:
        obj.hide_viewport = False
        obj.hide_set(False)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    for block in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.objects):
        for item in list(block):
            if item.users == 0:
                block.remove(item)
    random.seed(20250802)


def material(name):
    key = "MAT:%s" % name
    if key in bpy.data.materials:
        return bpy.data.materials[key]
    mat = bpy.data.materials.new(key)
    mat.use_nodes = True
    mat.diffuse_color = PALETTE.get(name, (0.6, 0.6, 0.6, 1.0))
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = mat.diffuse_color
        bsdf.inputs["Roughness"].default_value = 0.85
    return mat


def assign(obj, name):
    obj.data.materials.clear()
    obj.data.materials.append(material(name))
    return obj


def box(size, location=(0, 0, 0), rotation=(0, 0, 0), name="box", mat="stonewall"):
    """Cuboid given as full extents, sitting where you put it."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = (size[0], size[1], size[2])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return assign(obj, mat)


def cylinder(radius, depth, location=(0, 0, 0), rotation=(0, 0, 0), verts=16,
             name="cyl", mat="oak"):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, vertices=verts,
                                        location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    return assign(obj, mat)


def cone(radius1, radius2, depth, location=(0, 0, 0), rotation=(0, 0, 0), verts=16,
         name="cone", mat="oak"):
    bpy.ops.mesh.primitive_cone_add(radius1=radius1, radius2=radius2, depth=depth,
                                    vertices=verts, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    return assign(obj, mat)


def sphere(radius, location=(0, 0, 0), segments=16, rings=10, name="sph", mat="leaves"):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, segments=segments,
                                         ring_count=rings, location=location)
    obj = bpy.context.object
    obj.name = name
    return assign(obj, mat)


def wedge(width, height, depth, location=(0, 0, 0), rotation=(0, 0, 0),
          name="wedge", mat="rooftile"):
    """Triangular prism: a gable roof. Apex along the depth axis."""
    mesh = bpy.data.meshes.new(name)
    w, h, d = width / 2, height, depth / 2
    verts = [(-w, -d, 0), (w, -d, 0), (0, -d, h), (-w, d, 0), (w, d, 0), (0, d, h)]
    faces = [(0, 1, 2), (5, 4, 3), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)]
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = rotation
    return assign(obj, mat)


def bevel(obj, width=0.02, segments=2, angle=40):
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle)
    mod.harden_normals = segments > 1
    return obj


def solidify(obj, thickness=0.05):
    mod = obj.modifiers.new("solidify", "SOLIDIFY")
    mod.thickness = thickness
    return obj


def array(obj, count, offset):
    mod = obj.modifiers.new("array", "ARRAY")
    mod.count = count
    mod.use_relative_offset = False
    mod.use_constant_offset = True
    mod.constant_offset_displace = offset
    return obj


def shade_smooth(obj, angle=35):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.shade_smooth()
    mod = obj.modifiers.new("smooth by angle", "NODES")
    try:
        node_group = bpy.data.node_groups["Smooth by Angle"]
    except KeyError:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(angle))
        obj.modifiers.remove(mod)
        return obj
    mod.node_group = node_group
    return obj


def apply_modifiers(obj):
    bpy.context.view_layer.objects.active = obj
    for mod in list(obj.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
        except RuntimeError:
            obj.modifiers.remove(mod)
    return obj


def join(objs, name="asset"):
    """Merge into one object per material so the viewer gets few draw calls."""
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    result = bpy.context.object
    result.name = name
    return result


def uv_project(obj, scale=1.0):
    """Cube-projected UVs, which is what the viewer's world-space textures want."""
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=scale)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def export(name, objs=None, **kwargs):
    """`kwargs` go straight through to the glTF exporter -- the rigged asset
    needs the animation flags, and nothing else does."""
    os.makedirs(ASSETS, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    targets = objs if objs is not None else [o for o in bpy.context.scene.objects if o.type == "MESH"]
    for obj in targets:
        obj.select_set(True)
    if targets:
        bpy.context.view_layer.objects.active = targets[0]
    path = os.path.join(ASSETS, "%s.glb" % name)
    opts = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,          # excludes armatures, so skinning survives
        export_yup=True,
        export_materials="EXPORT",
        export_normals=True,
        export_texcoords=True,
        export_extras=False,
    )
    opts.update(kwargs)
    bpy.ops.export_scene.gltf(**opts)
    size = os.path.getsize(path)
    tris = sum(len(o.data.loop_triangles) for o in targets if o.type == "MESH")
    return "%s.glb  %d bytes" % (name, size)


def stats(objs):
    total = 0
    for obj in objs:
        if obj.type != "MESH":
            continue
        obj.data.calc_loop_triangles()
        total += len(obj.data.loop_triangles)
    return total
