"""The promo's opening: a 1993 terminal dialling in to a Merc mud.

Renders frames of a green-phosphor terminal from a script of typed and
received text. The received text is the real Merc 2.1 server's output,
captured over telnet from merc21/src/merc run on port 4400 (script.md); the
paragraphs are re-wrapped to the terminal's width the way a client would.

    python3 tools/promo/terminal.py --w 1920 --h 1080 --out DIR [--size 52]

Writes DIR/t00000.png ... and DIR/keys.json: the time of every keystroke,
of every Enter and of the modem, for the sound mix.
Fonts: IBM Plex Mono (SIL OFL 1.1).
"""
import argparse, json, os, textwrap
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument('--w', type=int, default=1920)
ap.add_argument('--h', type=int, default=1080)
ap.add_argument('--size', type=int, default=52)
ap.add_argument('--fps', type=int, default=30)
ap.add_argument('--seconds', type=float, default=7.6)
ap.add_argument('--out', required=True)
ap.add_argument('--font', default=os.path.expanduser('~/Library/Fonts/IBMPlexMono-Medium.ttf'))
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)

font = ImageFont.truetype(a.font, a.size)
cw = font.getlength('M')
lh = int(a.size * 1.22)
margin_x = int(a.w * 0.05)
margin_y = int(a.h * 0.07)
cols = int((a.w - 2 * margin_x) // cw)
rows = int((a.h - 2 * margin_y) // lh)

TEMPLE = [
    'The Temple Of Midgaard',
    'You are in the southern end of the temple hall in the Temple of Midgaard. '
    'The temple has been constructed from giant marble blocks, eternal in appearance, '
    'and most of the walls are covered by ancient wall paintings picturing Gods, Giants and peasants.',
    '   Large steps lead down through the grand temple gate, descending the huge mound '
    'upon which the temple is built and ends on the temple square below.',
    '(White Aura) The executioner is here polishing his blade.',
]
SQUARE = ['The Temple Square',
          'You are standing on the temple square.  Huge marble steps lead up to the temple gate.']

def wrap(par):
    indent = len(par) - len(par.lstrip(' '))
    return textwrap.wrap(par.strip(), cols, initial_indent=' ' * indent) or ['']

# The script: (time, kind, payload). 'type' is typed at a human pace with a
# keystroke each; 'recv' arrives at line speed; 'prompt' is the mud's prompt.
CPS_TYPE = 11.0
CPS_RECV = 1100.0
script = [
    (0.25, 'type', 'ATDT 555 0193'),
    (None, 'enter', None),
    (3.15, 'recv', ['CONNECT 14400', '']),
    (3.45, 'recv', wrap('Welcome to Merc Diku Mud.  May your visit here be ... Mercenary.') + ['']),
    (None, 'prompt', '<20hp 100m 100mv> '),
    (3.95, 'type', 'recall'),
    (None, 'enter', None),
    (None, 'recv', [l for p in TEMPLE for l in wrap(p)] + ['']),
    (None, 'prompt', '<20hp 100m 50mv> '),
    (5.55, 'recv', ['You are hungry.', '']),
    (None, 'prompt', '<20hp 100m 50mv> '),
    (6.05, 'type', 'south'),
    (None, 'enter', None),
    (None, 'recv', [l for p in SQUARE for l in wrap(p)]),
]

# Expand to timed character events.
events = []          # (t, op, arg): op in 'char' (append), 'nl' (new line)
keys = {'keys': [], 'enters': [], 'modem': None}
t = 0.0
rng = np.random.default_rng(1993)
for when, kind, payload in script:
    if when is not None: t = max(t, when)
    if kind == 'type':
        for ch in payload:
            events.append((t, 'char', ch)); keys['keys'].append(round(t, 3))
            t += (1 / CPS_TYPE) * float(rng.uniform(0.6, 1.5))
    elif kind == 'enter':
        t += 0.12
        events.append((t, 'nl', None)); keys['enters'].append(round(t, 3))
        if not keys['modem']: keys['modem'] = round(t + 0.1, 3); t += 0.1
        t += 0.12
    elif kind == 'prompt':
        for ch in payload: events.append((t, 'char', ch))
        t += len(payload) / CPS_RECV
    elif kind == 'recv':
        for line in payload:
            for ch in line:
                events.append((t, 'char', ch)); t += 1 / CPS_RECV
            events.append((t, 'nl', None)); t += 4 / CPS_RECV
json.dump(keys, open(os.path.join(a.out, 'keys.json'), 'w'), indent=1)

GREEN = (120, 255, 140)
DIM = (70, 190, 95)

def state_at(time):
    lines = ['']
    for et, op, arg in events:
        if et > time: break
        if op == 'char':
            if len(lines[-1]) >= cols: lines.append('')
            lines[-1] += arg
        else:
            lines.append('')
    return lines

# Static layers: scanlines and a vignette, both multiplied in.
yy, xx = np.mgrid[0:a.h, 0:a.w].astype(np.float32)
scan = 0.82 + 0.18 * (np.sin(yy * np.pi / 2.0) ** 2)
r = np.sqrt(((xx - a.w / 2) / (a.w / 2)) ** 2 + ((yy - a.h / 2) / (a.h / 2)) ** 2)
vignette = np.clip(1.08 - 0.42 * r ** 2.2, 0, 1)
shade = (scan * vignette)[..., None]
noise_rng = np.random.default_rng(7)

frames = int(round(a.seconds * a.fps))
for f in range(frames):
    time = f / a.fps
    lines = state_at(time)
    view = lines[-rows:]
    img = Image.new('RGB', (a.w, a.h), (0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, line in enumerate(view):
        colour = DIM if line.startswith('<') else GREEN
        d.text((margin_x, margin_y + i * lh), line, font=font, fill=colour)
    # Block cursor: solid while text is arriving, blinking at 2 Hz when idle.
    busy = any(abs(et - time) < 0.15 for et, _, _ in events)
    if busy or (time * 2) % 1 < 0.6:
        cx = margin_x + cw * len(view[-1]); cy = margin_y + (len(view) - 1) * lh
        d.rectangle([cx + 2, cy + int(a.size * 0.25), cx + cw - 2, cy + int(a.size * 1.12)], fill=GREEN)
    glow = img.filter(ImageFilter.GaussianBlur(a.size * 0.22))
    halo = img.filter(ImageFilter.GaussianBlur(a.size * 0.9))
    x = (np.asarray(img, np.float32) + 0.9 * np.asarray(glow, np.float32) + 0.35 * np.asarray(halo, np.float32))
    x = x * shade + 6 + noise_rng.normal(0, 2.0, (a.h, a.w, 1))
    Image.fromarray(np.clip(x, 0, 255).astype(np.uint8)).save(os.path.join(a.out, f't{f:05d}.png'))
print(f'{frames} frames, {cols} cols x {rows} rows, keys at {keys["keys"][:3]}..., modem {keys["modem"]}')
