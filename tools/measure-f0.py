"""量一段语音的基频中位数与频谱重心 —— 用来给启动音定调性。
（和当初量另外 11 段用的是同一套自相关法，保证可比。）
"""
import subprocess
import sys
import os
import numpy as np
from scipy.io import wavfile

FF = os.environ.get("FFMPEG", "ffmpeg")


def load(p, sr=24000):
    t = p + ".an.wav"
    subprocess.run([FF, '-y', '-i', p, '-ar', str(sr), '-ac', '1', t], capture_output=True)
    _, y = wavfile.read(t)
    os.remove(t)
    return y.astype(np.float32) / 32768.0, sr


def f0_median(y, sr, fmin=140, fmax=600):
    n, h = int(sr * 0.04), int(sr * 0.01)
    lo, hi = int(sr / fmax), int(sr / fmin)
    out = []
    for s in range(0, len(y) - n, h):
        seg = y[s:s + n]
        if np.sqrt((seg ** 2).mean()) < 0.02:
            continue
        seg = seg - seg.mean()
        ac = np.correlate(seg, seg, mode="full")[n - 1:]
        if ac[0] <= 0 or hi >= len(ac):
            continue
        ac = ac / ac[0]
        pk = int(np.argmax(ac[lo:hi])) + lo
        if ac[pk] < 0.35:
            continue
        out.append(sr / pk)
    return float(np.median(out)) if len(out) >= 10 else float('nan'), len(out)


def centroid(y, sr):
    n = 1024
    frames = [y[i:i + n] for i in range(0, len(y) - n, n // 2)]
    frames = [f for f in frames if np.sqrt((f ** 2).mean()) > 0.02]
    if not frames:
        return float('nan')
    w = np.hanning(n)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    acc = np.zeros_like(freqs)
    for f in frames:
        acc += np.abs(np.fft.rfft(f * w))
    return float((freqs * acc).sum() / (acc.sum() + 1e-9))


if __name__ == '__main__':
    d = sys.argv[1] if len(sys.argv) > 1 else 'assets'
    names = ['chatgpt', 'gemini', 'claude', 'kimi', 'deepseek', 'glm',
             'qwen', 'grok', 'minimax', 'musespark', 'mimo', 'doubao']
    print(f"{'角色':<11}{'F0(Hz)':>9}{'浊音帧':>8}{'频谱重心':>10}")
    data = {}
    for nm in names:
        p = os.path.join(d, nm + '.mp3')
        if not os.path.exists(p):
            continue
        y, sr = load(p)
        f0, n = f0_median(y, sr)
        c = centroid(y, sr)
        data[nm] = f0
        print(f"{nm:<11}{f0:>9.0f}{n:>8}{c:>10.0f}")
    f0s = [v for v in data.values() if v == v]
    print(f"\nF0 范围 {min(f0s):.0f}~{max(f0s):.0f} Hz")
    print('CHARS = {' + ', '.join(f"{k}: {v:.0f}" for k, v in data.items() if v == v) + '}')
