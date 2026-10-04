"""Loudness envelope of an audio file: RMS dBFS per window, one line, so a
clip can be "listened to" by its shape. python3 envelope.py file [window_s]"""
import subprocess, sys
import numpy as np
f = sys.argv[1]; win = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], capture_output=True, check=True).stdout
x = np.frombuffer(raw, dtype=np.float32)
n = int(16000 * win)
vals = [20 * np.log10(max(1e-6, float(np.sqrt(np.mean(x[i:i + n] ** 2))))) for i in range(0, len(x), n)]
print(f'{len(x) / 16000:.2f}s  window {win}s  peak {20 * np.log10(max(1e-6, float(np.abs(x).max()))):.1f} dBFS')
print(' '.join(f'{v:.0f}' for v in vals))
