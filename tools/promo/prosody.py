"""Prosody of a spoken clip, as numbers: duration, speech rate, loudness spread,
pitch median and range (semitones, 10th-90th percentile), longest pause.
python3 prosody.py file.mp3 [words]"""
import subprocess, sys
import numpy as np
SR = 16000
def load(f):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)
def analyse(f, words=None):
    x = load(f); hop = 160; win = 640
    rms, f0 = [], []
    for i in range(0, len(x) - win, hop):
        fr = x[i:i + win] * np.hanning(win)
        e = float(np.sqrt(np.mean(fr ** 2))); rms.append(e)
        if e < 0.01: f0.append(0); continue
        ac = np.correlate(fr, fr, 'full')[win - 1:]
        lo, hi = SR // 400, SR // 60
        k = lo + int(np.argmax(ac[lo:hi]))
        f0.append(SR / k if ac[k] > 0.35 * ac[0] else 0)
    rms = np.array(rms); f0 = np.array(f0)
    db = 20 * np.log10(np.maximum(rms, 1e-6)); speech = db > db.max() - 35
    v = f0[f0 > 0]; st = 12 * np.log2(v / np.median(v))
    # pauses: runs of non-speech inside the clip
    idx = np.where(speech)[0]; a, b = idx[0], idx[-1]; gaps = []; run = 0
    for s in speech[a:b]:
        run = run + 1 if not s else 0; gaps.append(run)
    dur = (b - a) * hop / SR
    out = dict(file=f.split('/')[-1], speech_s=round(dur, 2), f0_median=round(float(np.median(v)), 1),
               f0_range_st=round(float(np.percentile(st, 90) - np.percentile(st, 10)), 1),
               loud_spread_db=round(float(np.percentile(db[speech], 90) - np.percentile(db[speech], 10)), 1),
               longest_pause_s=round(max(gaps) * hop / SR, 2))
    if words: out['words_per_s'] = round(words / dur, 2)
    return out
for f in sys.argv[1:]:
    print(analyse(f))
