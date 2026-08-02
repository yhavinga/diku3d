#!/usr/bin/env python3
"""Vendor three.js + the addons we use, resolving relative imports recursively.

Everything lands under vendor/three/ mirroring the npm layout, so the relative
imports inside the addon files keep working and the importmap in index.html only
needs two entries.
"""
import os
import re
import subprocess
import sys
from posixpath import normpath, dirname, join

VERSION = sys.argv[1] if len(sys.argv) > 1 else "0.185.1"
BASE = f"https://unpkg.com/three@{VERSION}/"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor", "three")

SEEDS = [
    "build/three.module.js",
    "examples/jsm/controls/PointerLockControls.js",
    "examples/jsm/objects/Sky.js",
    "examples/jsm/postprocessing/EffectComposer.js",
    "examples/jsm/postprocessing/RenderPass.js",
    "examples/jsm/postprocessing/UnrealBloomPass.js",
    "examples/jsm/postprocessing/OutputPass.js",
    "examples/jsm/postprocessing/GTAOPass.js",
    "examples/jsm/postprocessing/SMAAPass.js",
    "examples/jsm/loaders/GLTFLoader.js",
    "examples/jsm/utils/BufferGeometryUtils.js",
    "examples/jsm/utils/SkeletonUtils.js",
]

IMPORT_RE = re.compile(r"""(?:from|import)\s*\(?\s*['"]([^'"]+)['"]""")

seen = set()
bare = set()
queue = list(SEEDS)

while queue:
    rel = queue.pop()
    if rel in seen:
        continue
    seen.add(rel)
    url = BASE + rel
    # curl rather than urllib: the system Python has no CA bundle wired up.
    src = subprocess.run(
        ["curl", "-fsSL", url], capture_output=True, check=True
    ).stdout.decode("utf-8")
    dest = os.path.join(OUT, *rel.split("/"))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w") as fh:
        fh.write(src)
    for spec in IMPORT_RE.findall(src):
        if spec.startswith("."):
            queue.append(normpath(join(dirname(rel), spec)))
        elif spec != "three":
            bare.add((rel, spec))

print(f"three@{VERSION} -> {OUT}")
for path in sorted(seen):
    print("  ", path)
if bare:
    print("unresolved bare specifiers (need an importmap entry):")
    for rel, spec in sorted(bare):
        print(f"   {spec}  <- {rel}")
