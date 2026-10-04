"""Cut the promo: picture, burned-in English subtitles and mud lines, title
card, and a sound mix levelled to -14 LUFS for social.

    python3 tools/promo/edit.py [--cut full|teaser] [--fmt 16x9|1x1] [--out FILE]

Everything it reads lives in /Users/yeb/Movies/diku3d-promo (never in the
repo): takes/<shot>/fNNNNN.jpg from capture.mjs, terminal-<fmt>/ from
terminal.py, audio/*.mp3 from audio.mjs, fonts/ (all SIL OFL 1.1: EB
Garamond, Noto Sans, IBM Plex Mono). The game's own sounds come from
assets/audio. The timeline below is the storyboard as cut.
"""
import argparse, json, os, subprocess, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = '/Users/yeb/Movies/diku3d-promo'
TAKES = f'{WORK}/takes'
FONTS = f'{WORK}/fonts'
GAME_AUDIO = f'{ROOT}/assets/audio'
FPS = 30
SR = 48000

ap = argparse.ArgumentParser()
ap.add_argument('--cut', default='full')
ap.add_argument('--fmt', default='16x9')
ap.add_argument('--out', default=None)
ap.add_argument('--fast', action='store_true', help='quick preview encode')
a = ap.parse_args()
W, H = (1920, 1080) if a.fmt == '16x9' else (1080, 1080)

# ------------------------------------------------------------- timeline --
# Segments: (take, edit start, duration, source start, square-crop centre 0..1).
# 'terminal' is the rendered terminal; the first cut out of it is a dissolve.
FULL = dict(
    length=60.0,
    segments=[
        ('terminal', 0.0, 7.6, 0.0, 0.5),
        ('s01-temple', 7.0, 6.8, 0.2, 0.5),
        ('s02-market', 13.8, 2.0, 0.8, 0.45),
        ('s04-grove', 15.8, 1.8, 0.8, 0.5),
        ('x-greendragon', 17.6, 1.8, 0.8, 0.62),
        ('x-marsh', 19.4, 1.8, 0.8, 0.4),
        ('s11-myconid', 21.2, 1.8, 1.0, 0.5),
        ('x-arachnos', 23.0, 1.8, 0.8, 0.5),
        ('s08-party', 24.8, 3.6, 0.0, 0.5),
        ('s09-fight', 28.4, 5.2, 0.2, 0.5),
        ('s12-dragon', 33.6, 1.8, 1.67, 0.5),
        ('s13b-guard', 35.4, 3.2, 0.0, 0.5),
        ('s13-fido', 38.6, 3.0, 0.4, 0.5),
        ('s15-night', 41.6, 3.8, 0.5, 0.5),
        ('s16-gate', 45.4, 14.6, 1.5, 0.5),
    ],
    dissolve=(7.0, 0.6),
    fade_out=(59.2, 0.8),
    title=(52.6, 60.0),
    # (start, end, text): the mud's own lines, as the console shows them.
    mud=[
        (13.9, 16.4, "The mayor says 'I hereby declare the city of Midgaard open!'"),
        (25.0, 28.3, 'Thorne now follows you.'),
        (25.4, 28.3, 'Kestrel now follows you.'),
        (25.8, 28.3, 'Wren now follows you.'),
        (26.2, 28.3, 'Mordecai now follows you.'),
        (28.6, 31.8, "Mordecai utters the words, 'yucandusbarr'."),
        (29.1, 31.8, "Mordecai's fireball *** ANNIHILATES *** the giant, purple sand worm!"),
        (31.9, 33.55, 'The giant, purple sand worm is DEAD!!'),
        (32.3, 33.55, "Kestrel utters the words, 'pzar'."),
        (32.8, 33.55, 'You split 120 gold coins.  Your share is 24 gold coins.'),
        (35.5, 38.5, "The cityguard screams 'PROTECT THE INNOCENT!!  BANZAI!!'"),
        (38.8, 41.5, 'The beastly fido savagely devours a corpse.'),
        (43.2, 45.3, 'You are hungry.'),
    ],
    # Voice-over clips (file start) and their subtitles (start, end, text).
    vo=[('vo1', 8.4), ('vo2', 15.8), ('vo3', 25.2), ('vo4', 36.9), ('vo5', 46.6), ('vo6', 54.2)],
    subs=[
        (8.45, 11.0, 'You walked these streets a thousand times.'),
        (11.4, 13.1, 'You just never saw them.'),
        (15.9, 19.4, 'Every room, every exit, every mob...'),
        (19.7, 22.5, '...built straight from the original area files.'),
        (25.3, 27.0, 'Group up with old friends.'),
        (27.4, 28.6, 'Follow the leader.'),
        (29.0, 30.6, 'Fight side by side,'),
        (30.7, 32.8, 'while the cleric mutters her words.'),
        (37.0, 38.7, 'The guards still shout.'),
        (39.1, 41.3, 'The fido still eats corpses.'),
        (41.7, 42.9, 'And yes...'),
        (43.0, 44.8, 'you are still hungry.'),
        (46.7, 48.9, 'Same mud. New eyes.'),
        (49.3, 51.0, 'Free, in your browser...'),
        (51.3, 53.0, 'and your friends can come too.'),
        (56.6, 58.2, '{\\an8\\pos(%d,%d)}See you in Midgaard.'),
    ],
    music=(9.0, 0.0),           # (edit time, file offset): its cadence lands under the card
    # Ambience beds: (start, end, clip, gain dB).
    amb=[
        (7.0, 13.8, 'amb_temple', -4), (13.8, 15.8, 'amb_town_day', 0), (15.8, 17.6, 'amb_forest', 0),
        (17.6, 19.4, 'amb_tavern', -3), (19.4, 21.2, 'amb_marsh', 0), (21.2, 23.0, 'amb_cave', 0),
        (23.0, 24.8, 'amb_fields', 0), (24.8, 28.4, 'amb_market', -2), (28.4, 33.6, 'amb_desert', 0),
        (33.6, 35.4, 'amb_cave', 0), (35.4, 38.6, 'amb_house', 0), (38.6, 41.6, 'amb_town_day', 0),
        (41.6, 45.4, 'amb_town_night', 0), (45.4, 50.2, 'amb_town_day', -2), (50.2, 60.0, 'amb_forest', 0),
    ],
    # One-shots: (time, clip, gain dB, window s or None for the whole clip).
    sfx=[
        (13.9, 'vo_mayor_mayor_open', -3, None),
        (28.55, 'vo_mage_m_fireball_c', -2, None), (29.1, 'sp_fire', -2, 2.2),
        (29.8, 'cmb_swing', -6, 0.5), (30.4, 'cmb_hit_flesh', -5, 0.5), (31.2, 'cmb_parry', -6, 0.5),
        (31.7, 'cmb_hit_flesh', -5, 0.5), (32.2, 'cmb_death_beast', -2, 1.4),
        (32.3, 'vo_cleric_f_heal_c', -1, None), (32.5, 'sp_heal', -6, 1.0), (32.85, 'sv_coins', -8, 0.6),
        (34.4, 'cr_dragon', -3, 1.2), (34.7, 'sp_fire', -4, 1.0),
        (35.5, 'vo_guard_m_guard_scream', -2, None),
        (38.9, 'cr_dog', -6, 0.9), (42.0, 'pos_fountain', -10, 3.0),
        (48.6, 'promo:sfx_gate', -5, None),
    ],
    keys='terminal',
)

# The teaser reuses the same takes: the terminal's last three seconds, the
# temple, three beats and the gate with the title.
TEASER = dict(
    length=15.0,
    segments=[
        ('terminal', 0.0, 3.2, 4.4, 0.5),
        ('s01-temple', 2.6, 3.9, 0.9, 0.5),
        ('s04-grove', 6.5, 1.4, 0.9, 0.5),
        ('s12-dragon', 7.9, 1.6, 1.87, 0.5),
        ('s09-fight', 9.5, 2.2, 3.3, 0.5),
        ('s16-gate', 11.7, 3.3, 10.4, 0.5),
    ],
    dissolve=(2.6, 0.6),
    fade_out=(14.4, 0.6),
    title=(11.7, 15.0),
    mud=[(9.9, 11.6, 'The giant, purple sand worm is DEAD!!')],
    vo=[('vo1', 2.9), ('vo6', 10.3)],
    subs=[(2.95, 5.2, 'You walked these streets a thousand times.'), (5.3, 7.2, 'You just never saw them.')],
    music=(2.4, 31.5),
    amb=[(2.6, 6.5, 'amb_temple', -4), (6.5, 7.9, 'amb_forest', 0), (7.9, 9.5, 'amb_cave', 0),
         (9.5, 11.7, 'amb_desert', 0), (11.7, 15.0, 'amb_forest', 0)],
    sfx=[(8.3, 'cr_dragon', -3, 1.2), (8.6, 'sp_fire', -4, 1.0), (10.0, 'cmb_death_beast', -2, 1.4)],
    keys='terminal', keys_offset=-4.4,
)
T = FULL if a.cut == 'full' else TEASER
out = a.out or f'{WORK}/{"promo_60s" if a.cut == "full" else "teaser_15s"}_{a.fmt}.mp4'
tmp = tempfile.mkdtemp(prefix=f'edit-{a.cut}-{a.fmt}-', dir=WORK)

# ------------------------------------------------------------- picture --
def frame_paths(take, start, dur):
    if take == 'terminal':
        d = f'{WORK}/terminal-{a.fmt}'; pat = 't{:05d}.png'
    else:
        d = f'{TAKES}/{take}'; pat = 'f{:05d}.jpg'
    first = int(round(start * FPS)); n = int(round(dur * FPS))
    have = sorted(f for f in os.listdir(d) if f[0] in 'ft' and f[1:6].isdigit())
    last = int(have[-1][1:6])
    # Past the take's end the last frame is held (the gate under the title).
    return [os.path.join(d, pat.format(min(first + i, last))) for i in range(n)]

def load(path, crop_c):
    im = Image.open(path).convert('RGB')
    if im.size != (W, H):
        if a.fmt == '1x1' and im.size[0] > im.size[1]:
            s = H / im.size[1]
            im = im.resize((int(round(im.size[0] * s)), H), Image.LANCZOS)
            x0 = int(round(crop_c * im.size[0] - W / 2)); x0 = max(0, min(im.size[0] - W, x0))
            im = im.crop((x0, 0, x0 + W, H))
        else:
            im = im.resize((W, H), Image.LANCZOS)
    return np.asarray(im, np.float32)

def title_card():
    """The end card: name, promise, address, and the credits the DikuMUD and
    Merc licences require, over the forest the gate opens on."""
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = W / 1920 if a.fmt == '16x9' else 1080 / 1500
    garamond = lambda s: ImageFont.truetype(f'{FONTS}/EBGaramond-Medium.otf', int(s * k))
    mono = lambda s: ImageFont.truetype(f'{FONTS}/IBMPlexMono-Medium.ttf', int(s * k))
    INK = (240, 227, 200, 255); GOLD = (224, 189, 119, 255)
    def centre(y, text, font, fill, spacing=0):
        if spacing:
            widths = [font.getlength(c) + spacing for c in text]; x = (W - sum(widths) + spacing) / 2
            for c, w in zip(text, widths): d.text((x, y), c, font=font, fill=fill); x += w
        else:
            d.text(((W - font.getlength(text)) / 2, y), text, font=font, fill=fill)
    cy = H * (0.30 if a.fmt == '16x9' else 0.30)
    centre(cy, 'diku3d', garamond(190), INK)
    centre(cy + 250 * k, 'THE MUD YOU KNOW, NOW IN 3D', mono(34), GOLD, spacing=6 * k)
    centre(cy + 320 * k, 'FREE IN YOUR BROWSER  ·  PLAY TOGETHER', mono(34), GOLD, spacing=6 * k)
    centre(cy + 410 * k, 'diku3d.com', garamond(96), INK)
    small = mono(19 if a.fmt == '16x9' else 21)
    lines = ['DikuMUD by Hans Henrik Stærfeldt, Katja Nyboe, Tom Madsen, Michael Seifert and Sebastian Hammer',
             'Merc 2.1 by Furey, Hatchet and Kahn  ·  areas from the stock Merc 2.1 release  ·  non-commercial']
    if a.fmt == '1x1':
        lines = ['DikuMUD by Hans Henrik Stærfeldt, Katja Nyboe,', 'Tom Madsen, Michael Seifert and Sebastian Hammer',
                 'Merc 2.1 by Furey, Hatchet and Kahn', 'areas from the stock Merc 2.1 release  ·  non-commercial']
    y = H - (len(lines) * 30 + 50) * (1 if a.fmt == '16x9' else 1.15)
    for line in lines:
        centre(y, line, small, (240, 227, 200, 200)); y += 30 * (1 if a.fmt == '16x9' else 1.15)
    return np.asarray(img, np.float32) / 255

def picture():
    segs = T['segments']
    total = int(round(T['length'] * FPS))
    card = title_card()
    dis_t, dis_d = T['dissolve']
    t0, t1 = T['title']
    fo_t, fo_d = T['fade_out']
    plan = []
    for take, start, dur, src, crop in segs:
        plan.append((int(round(start * FPS)), frame_paths(take, src, dur), crop))
    enc = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
                            '-r', str(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast' if a.fast else 'slow',
                            '-crf', '12', '-pix_fmt', 'yuv420p', f'{tmp}/picture.mp4'], stdin=subprocess.PIPE)
    for f in range(total):
        t = f / FPS
        layers = [(s, paths, c) for s, paths, c in plan if s <= f < s + len(paths)]
        if len(layers) > 1:
            # Only the dissolve overlaps: the later segment fades in over it.
            (s0, p0, c0), (s1, p1, c1) = layers[0], layers[-1]
            u = min(1, max(0, (t - dis_t) / dis_d)); u = u * u * (3 - 2 * u)
            img = load(p0[f - s0], c0) * (1 - u) + load(p1[f - s1], c1) * u
        elif layers:
            s0, p0, c0 = layers[0]; img = load(p0[f - s0], c0)
        else:
            img = np.zeros((H, W, 3), np.float32)
        if t >= t0:
            u = min(1, (t - t0) / 1.2)
            img = img * (1 - 0.58 * u)
            img = img * (1 - card[..., 3:] * u) + card[..., :3] * 255 * card[..., 3:] * u
        if t >= fo_t:
            img = img * max(0, 1 - (t - fo_t) / fo_d)
        enc.stdin.write(np.clip(img, 0, 255).astype(np.uint8).tobytes())
    enc.stdin.close(); enc.wait()

# ------------------------------------------------------------ subtitles --
def ass_time(t):
    return f'{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}'

def subtitles():
    sq = a.fmt == '1x1'
    sub_size = 66 if not sq else 56
    mud_size = 44 if not sq else 34
    margin_v = 96 if not sq else 120
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Noto Sans SemiBold,{sub_size},&H00F2F6F7,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,3.2,1.5,2,{90 if not sq else 60},{90 if not sq else 60},{margin_v},1
Style: Mud,IBM Plex Mono Medium,{mud_size},&H008CFF78,&H00FFFFFF,&H00000000,&HA0000000,0,0,0,0,100,100,0,0,3,10,0,7,{72 if not sq else 48},{72 if not sq else 48},{64 if not sq else 56},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    rows = []
    for s, e, text in T['subs']:
        if '%d' in text: text = text % (W // 2, int(H * (0.83 if not sq else 0.66)))
        rows.append(f'Dialogue: 0,{ass_time(s)},{ass_time(e)},Sub,,0,0,0,,{{\\fad(120,120)}}{text}')
    # Mud lines stack downwards from the top-left, a line each, like a log.
    line_h = int(mud_size * 1.65)
    active = []
    for s, e, text in T['mud']:
        active = [(s2, e2) for s2, e2 in active if e2 > s]
        slot = len(active)
        active.append((s, e))
        y = (64 if not sq else 56) + slot * line_h * (2 if sq and len(text) > 52 else 1)
        rows.append(f'Dialogue: 1,{ass_time(s)},{ass_time(e)},Mud,,0,0,{y},,{{\\fad(60,200)}}{text}')
    path = f'{tmp}/subs.ass'
    open(path, 'w').write(header + '\n'.join(rows) + '\n')
    return path

# ---------------------------------------------------------------- sound --
def decode(path, offset=0.0, dur=None):
    cmd = ['ffmpeg', '-v', 'error', '-ss', str(offset), '-i', path]
    if dur: cmd += ['-t', str(dur)]
    raw = subprocess.run(cmd + ['-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()

def clip_path(name):
    if name.startswith('promo:'): return f'{WORK}/audio/{name[6:]}.mp3'
    return f'{GAME_AUDIO}/{name}.ogg'

def rms_db(x):
    return 20 * np.log10(max(1e-9, float(np.sqrt(np.mean(x ** 2)))))

def level(x, target_db):
    """Scale to a target RMS over the clip's loud part (a loudness proxy)."""
    mono = np.abs(x).mean(axis=1)
    n = int(SR * 0.05); env = np.sqrt(np.convolve(mono ** 2, np.ones(n) / n, 'same'))
    loud = x[env > env.max() * 0.1] if env.max() > 0 else x
    return x * 10 ** ((target_db - rms_db(loud)) / 20)

def loudest(x, win):
    n = int(win * SR)
    if len(x) <= n: return x
    e = np.convolve((x ** 2).mean(axis=1), np.ones(int(SR * 0.02)), 'same')
    c = np.cumsum(e); best = int(np.argmax(c[n:] - c[:-n]))
    # Start a little before the peak window so the attack is kept.
    s = max(0, best - int(0.03 * SR))
    return x[s:s + n]

def fade(x, fin=0.01, fout=0.05):
    n = len(x); i = min(n, int(fin * SR)); o = min(n, int(fout * SR))
    if i: x[:i] *= np.linspace(0, 1, i)[:, None]
    if o: x[-o:] *= np.linspace(1, 0, o)[:, None]
    return x

def place(track, x, t):
    s = int(round(t * SR))
    if s < 0: x = x[-s:]; s = 0
    e = min(len(track), s + len(x))
    if e > s: track[s:e] += x[:e - s]

def sound():
    n = int(T['length'] * SR)
    vo = np.zeros((n, 2), np.float32); music = np.zeros_like(vo); amb = np.zeros_like(vo); fx = np.zeros_like(vo)
    for name, t in T['vo']:
        x = level(decode(f'{WORK}/audio/{name}.mp3'), -17)
        place(vo, fade(x, 0.005, 0.08), t)
    mt, moff = T['music']
    m = decode(f'{WORK}/audio/music_bed.mp3', moff)
    m = level(m, -21)
    place(music, fade(m, 0.6 if moff else 0.4, 1.5), mt)
    for s, e, name, g in T['amb']:
        x = decode(clip_path(name), 1.0, e - s + 0.3)
        x = level(x, -33 + g)
        place(amb, fade(x, 0.15, 0.15), s - 0.15)
    for t, name, g, win in T['sfx']:
        x = decode(clip_path(name))
        if win: x = loudest(x, win)
        x = level(x, -22 + g)
        place(fx, fade(x, 0.003, 0.06), t)
    # The terminal: one buckling-spring click per character typed, a
    # heavier one for Enter, and the modem's handshake after the dial string.
    keys = json.load(open(f'{WORK}/terminal-16x9/keys.json'))
    off = T.get('keys_offset', 0.0)
    typing = decode(f'{WORK}/audio/sfx_typing.mp3')
    env = np.abs(typing).mean(axis=1)
    peaks = [i for i in range(int(0.01 * SR), len(env) - int(0.08 * SR), int(0.004 * SR))
             if env[i] > 0.04 and env[i] == env[max(0, i - int(0.05 * SR)):i + int(0.05 * SR)].max()]
    clicks = [typing[max(0, p - int(0.004 * SR)):p + int(0.07 * SR)] for p in peaks] or [typing[:int(0.07 * SR)]]
    rng = np.random.default_rng(1993)
    for t in keys['keys']:
        place(fx, fade(level(clicks[rng.integers(len(clicks))].copy(), -27), 0.001, 0.02), t + off)
    big = max(clicks, key=lambda c: np.abs(c).max())
    for t in keys['enters']:
        place(fx, fade(level(big.copy(), -23), 0.001, 0.03), t + off)
    # A quiet room and a CRT's whine under the terminal, so the gaps between
    # keystrokes are a room and not a dropout.
    tl = next(seg for seg in T['segments'] if seg[0] == 'terminal')
    m = int((tl[1] + tl[2]) * SR); tt = np.arange(m) / SR
    tone = (0.0008 * np.sin(2 * np.pi * 15734 / 2 * tt) + 0.003 * rng.standard_normal(m)).astype(np.float32)
    tone *= np.minimum(1, np.minimum(tt / 0.3, (tt[-1] - tt) / 0.5))
    fx[:m] += tone[:, None]
    if off == 0.0:
        modem = decode(f'{WORK}/audio/sfx_modem_b.mp3', 0.45, 1.5)
        place(fx, fade(level(modem, -24), 0.02, 0.12), keys['modem'])
    # Duck music and ambience under the voice: an envelope of the VO,
    # smoothed (fast attack, slow release), takes the bed down by 9 dB.
    v = np.abs(vo).mean(axis=1)
    win = int(SR * 0.03); env = np.sqrt(np.convolve(v ** 2, np.ones(win) / win, 'same'))
    on = (env > 10 ** (-45 / 20)).astype(np.float32)
    # Hold the duck across the gaps between words.
    hold = int(SR * 0.45); on = np.convolve(on, np.ones(hold), 'same') > 0
    duck = np.ones(n, np.float32); g = 1.0; floor = 10 ** (-9 / 20)
    att, rel = 1 / (SR * 0.08), 1 / (SR * 0.6)
    target = np.where(on, floor, 1.0)
    for i in range(0, n, 64):  # control rate
        g += (target[i] - g) * (att if target[i] < g else rel) * 64
        duck[i:i + 64] = g
    mix = vo + (music + amb * 0.9) * duck[:, None] + fx * (0.75 + 0.25 * duck[:, None])
    # The end card fades with the picture.
    fo_t, fo_d = T['fade_out']
    s = int(fo_t * SR); mix[s:] *= np.linspace(1, 0, n - s)[:, None] ** 1.5
    path = f'{tmp}/mix.wav'
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', path],
                   input=mix.astype(np.float32).tobytes(), check=True)
    return path

def loudnorm(path):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af',
                        'loudnorm=I=-14:TP=-2:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True)
    j = json.loads(r.stderr[r.stderr.rindex('{'):r.stderr.rindex('}') + 1])
    return (f"loudnorm=I=-14:TP=-2:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}:"
            f"measured_LRA={j['input_lra']}:measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true")

picture()
ass = subtitles()
mix = sound()
norm = loudnorm(mix)
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', f'{tmp}/picture.mp4', '-i', mix,
                '-vf', f"subtitles={ass}:fontsdir={FONTS}", '-af', norm + ',alimiter=limit=0.7:level=false,aresample=48000',
                '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast' if a.fast else 'slow', '-crf', '20', '-maxrate', '14M', '-bufsize', '28M',
                '-pix_fmt', 'yuv420p', '-r', str(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
                '-movflags', '+faststart', '-shortest', out], check=True)
print('wrote', out, 'work in', tmp)
