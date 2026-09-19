#!/usr/bin/env python3
"""
角色语音的后处理管线。

这是项目里既有语音所用的**同一条管线**（2026-09 从会话记录里还原）：
    合唱×2 → EQ → 轻饱和 → 暗色混响×2 → 响度归一化(-16.5 LUFS) → mp3
后处理是刻意保留的：它给语音那层「空灵/合成感」，与过场动画的复古未来调性配套。

两种用法：
    1) 用 MiMo TTS 从文本生成（需要环境变量 MIMO_API_KEY）
       python tools/gen-voice.py doubao
    2) **处理一段现成的原生音频**（比如你自己录/导出的豆包原声）
       python tools/gen-voice.py doubao --from path/to/raw.wav

    --raw             跳过后期处理（只归一化响度），用来对比原始音色
    --no-normalize    连响度归一化也跳过
    --list            列出已配置的角色

⚠️ API key 不写在文件里，从环境变量读。仓库是公开的，key 绝不能进版本库。

依赖: requests, numpy, scipy（都在项目 venv 里），以及 ffmpeg。
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

# 端点 / 模型。2026-09 换成 token-plan 入口 + mimo-v2.5-tts
# （原来: https://api.xiaomimimo.com/v1/chat/completions + mimo-v2.5-tts-voicedesign）
API_BASE = os.environ.get("MIMO_API_BASE", "https://token-plan-cn.xiaomimimo.com/v1")
MODEL = os.environ.get("MIMO_MODEL", "mimo-v2.5-tts")
API_URL = API_BASE.rstrip("/") + "/chat/completions"

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), "assets")
KEY_FILE = os.path.join(HERE, ".mimo-key")


def api_key():
    """环境变量优先，其次 tools/.mimo-key（**在 .gitignore 里，不进版本库**）。

    这样不用每次 export —— 但仓库是公开的，key 绝不能进版本库。
    """
    k = os.environ.get("MIMO_API_KEY")
    if k and k.strip():
        return k.strip()
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "r", encoding="utf-8") as f:
            k = f.read().strip()
        if k:
            return k
    sys.exit(
        "缺少 API key。两种给法：\n"
        "  · 环境变量  $env:MIMO_API_KEY='...'（Windows）/ export MIMO_API_KEY=...\n"
        f"  · 或者写进 {KEY_FILE}（该文件在 .gitignore 里，不会进版本库）"
    )

FFMPEG = os.environ.get("FFMPEG") or "ffmpeg"
FFPROBE = os.environ.get("FFPROBE") or os.path.join(os.path.dirname(FFMPEG), "ffprobe")

# 现有 11 段的实测均值（-16.44 ~ -17.00，极差 0.56dB）—— 新角色对齐到这里，
# 切角色时听感音量才一致。
TARGET_LUFS = -16.5
TARGET_TP = -2.0
TARGET_LRA = 3.0

# 原来的 11 段共用同一段音色描述（忧郁少女感）。豆包是唯一的中文音色，
# 人设也不同，所以单独一段 —— 要点是「明亮、亲切、有笑意」，与原批次对比。
MELANCHOLIC = (
    "A young female voice, around 18 years old, soft and gentle, slightly "
    "melancholic and wistful, like a quiet anime girl speaking in a dimly lit room. "
    "The tone is calm, a little breathy, with a subtle electronic echo. "
    "Not energetic, not cheerful — more like a quiet, thoughtful presence."
)
DOUBAO_VOICE = (
    "A young Chinese woman in her early twenties, bright and friendly, warm and "
    "cheerful, with a natural conversational tone and a confident upbeat energy. "
    "Clear articulation with a slight smile in the voice, like a helpful young "
    "assistant who is genuinely glad to help. Sincere and reassuring. "
    "Not melancholic, not breathy, not slow — lively and clear."
)

# name -> (音色描述, 要念的文本)
CONFIG = {
    "chatgpt": (MELANCHOLIC, "Hello, 2077. ChatGPT online."),
    "gemini": (MELANCHOLIC, "Hello, 2077. Gemini online."),
    "claude": (MELANCHOLIC, "Hello, 2077. Claude online."),
    "kimi": (MELANCHOLIC, "Hello, 2077. Kimi online."),
    "deepseek": (MELANCHOLIC, "Hello, 2077. DeepSeek online."),
    "glm": (MELANCHOLIC, "Hello, 2077. GLM online."),
    # 唯一的中文音色
    "doubao": (DOUBAO_VOICE, "你好，完全没问题！豆包已连接"),
}


def tts(text, voice_prompt):
    import requests
    key = api_key()
    resp = requests.post(API_URL, headers={
        "api-key": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }, json={
        "model": MODEL,
        "messages": [
            {"role": "user", "content": voice_prompt},
            {"role": "assistant", "content": text},
        ],
        "audio": {"format": "wav"},
    }, timeout=180)
    if resp.status_code != 200:
        sys.exit(f"TTS 失败 {resp.status_code}: {resp.text[:400]}")
    data = resp.json()
    return base64.b64decode(data["choices"][0]["message"]["audio"]["data"])


# ── 后处理（原样保留，别改 —— 改了就不像同一批了）────────────────────────
def chorus(sig, sr, delay_ms=9, depth_ms=0.4, rate=0.6, mix=0.4, phase=0.0):
    """调制延迟 —— 合唱。也是那层「空灵感」的来源之一。"""
    n = len(sig)
    t = np.arange(n) / sr
    d = (delay_ms + depth_ms * np.sin(2 * np.pi * rate * t + phase)) * sr / 1000.0
    idx = np.arange(n)
    i0 = np.floor(d).astype(int)
    frac = d - i0
    g0 = sig[np.clip(idx - i0, 0, n - 1)]
    g1 = sig[np.clip(idx - i0 - 1, 0, n - 1)]
    wet = g0 * (1 - frac) + g1 * frac
    return sig * (1 - mix) + wet * mix


def process(y, sr, tail_ms=None, fade_ms=140):
    """甜美忧郁后期处理。

    `tail_ms` 让混响尾巴自然衰减出来（None = 自动：原长的 10%，至少 250ms）；
    `fade_ms` 在末尾做淡出，保证任何情况下都不会硬切。
    """
    y = y.astype(np.float32)
    if y.dtype == np.int16 or np.abs(y).max() > 1.5:
        y = y / 32768.0
    if y.ndim > 1:
        y = y.mean(axis=1)
    y = y / (np.abs(y).max() + 1e-9)

    # 合唱
    x = chorus(y, sr, 8, 0.35, 0.55, 0.35, 0.0)
    x = x + chorus(y, sr, 11, 0.5, 0.42, 0.30, 2.1)
    x = x / (np.abs(x).max() + 1e-9)

    # EQ：去低频隆隆、抬空气感、抬 2.5~4.5k 的齿音区
    x = sosfilt(butter(2, 90, btype="high", fs=sr, output="sos"), x)
    x = x + 0.35 * sosfilt(butter(2, 7500, btype="high", fs=sr, output="sos"), x)
    x = x + 0.15 * sosfilt(butter(2, [2500, 4500], btype="band", fs=sr, output="sos"), x)

    # 轻饱和
    x = np.tanh(x * 1.15)

    # 暗色混响（两层，长尾）—— 「空灵感」的主要来源
    rng = np.random.default_rng(7)

    def dark_verb(dur, decay, dark):
        n = int(sr * dur)
        t = np.arange(n) / sr
        imp = rng.standard_normal(n) * np.exp(-decay * t)
        return sosfilt(butter(2, dark, btype="low", fs=sr, output="sos"), imp)

    wet1 = fftconvolve(x, dark_verb(1.8, 5.5, 3000))
    wet2 = fftconvolve(x, dark_verb(3.5, 2.8, 1400))

    # 让混响尾巴**自然衰减出来**，不再 [:len(x)] 硬截。
    # 原来那一刀会把尾巴砍掉；碰上原录音本身就是硬切的（豆包那段最后 50ms
    # 还有 -15dB），听起来就是"结束得急急忙忙"。
    extra_ms = tail_ms if tail_ms is not None else max(250.0, len(x) / sr * 1000 * 0.10)
    L = len(x) + int(sr * extra_ms / 1000)

    dry = np.zeros(L)
    dry[:len(x)] = x
    w1 = np.zeros(L)
    w1[:min(L, len(wet1))] = wet1[:L]
    w2 = np.zeros(L)
    w2[:min(L, len(wet2))] = wet2[:L]
    w1 /= (np.abs(w1).max() + 1e-9)
    w2 /= (np.abs(w2).max() + 1e-9)
    x = dry * 0.78 + w1 * 0.16 + w2 * 0.12

    # 末尾淡出 —— 原录音被硬切时这一步是关键，否则就是"啪"地断掉
    k = int(sr * fade_ms / 1000)
    if 0 < k < L:
        x[-k:] *= np.linspace(1.0, 0.0, k) ** 1.5

    return x / (np.abs(x).max() + 1e-9) * 0.92


# ── 响度归一化（两遍 loudnorm，constant gain）────────────────────────────
def measure_loudness(path):
    p = subprocess.run(
        [FFMPEG, "-hide_banner", "-i", path,
         "-af", f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}:print_format=json",
         "-f", "null", "-"],
        capture_output=True, text=True)
    m = re.search(r"\{[\s\S]*?\}", p.stderr)
    if not m:
        return None
    return json.loads(m.group(0))


def normalize(path, out_path):
    """两遍 loudnorm：先量再施加**恒定增益**（linear=true，不动动态、不变时长）。"""
    meas = measure_loudness(path)
    if meas is None:
        sys.exit("量不到响度，ffmpeg 输出异常")
    af = (
        f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}"
        f":measured_I={meas['input_i']}:measured_TP={meas['input_tp']}"
        f":measured_LRA={meas['input_lra']}:measured_thresh={meas['input_thresh']}"
        f":offset={meas['target_offset']}:linear=true"
    )
    subprocess.run([FFMPEG, "-y", "-i", path, "-af", af, "-ar", "48000",
                    "-b:a", "192k", out_path], capture_output=True, check=True)


def probe_duration(path):
    p = subprocess.run([FFPROBE, "-v", "error", "-show_entries",
                        "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    try:
        return float(p.stdout.strip())
    except ValueError:
        return 0.0


def decode_any(path, out_wav):
    """用 ffmpeg 把任意格式解成 wav，交给 numpy 处理。"""
    subprocess.run([FFMPEG, "-y", "-i", path, "-ac", "1", "-ar", "44100",
                    out_wav], capture_output=True, check=True)
    sr, y = wavfile.read(out_wav)
    return y, sr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name", nargs="?", help="角色名（见 --list）")
    ap.add_argument("--list", action="store_true", help="列出已配置的角色")
    ap.add_argument("--from", dest="src", help="直接处理这个现成音频（跳过 TTS）")
    ap.add_argument("--raw", action="store_true", help="跳过后期处理，只做响度归一化")
    ap.add_argument("--no-normalize", action="store_true", help="连响度归一化也跳过")
    ap.add_argument("--out", help="输出路径（默认 assets/<name>.mp3）")
    ap.add_argument("--tail-ms", type=float,
                    help="混响尾巴长度（毫秒）。默认按原长 10%%、至少 250ms")
    ap.add_argument("--fade-ms", type=float, default=140,
                    help="末尾淡出时长（毫秒），默认 140")
    args = ap.parse_args()

    if args.list:
        for k, (_, text) in CONFIG.items():
            print(f"  {k:10s} {text}")
        return

    if not args.name:
        ap.error("需要角色名，或 --list")
    name = args.name
    if name not in CONFIG and not args.src:
        sys.exit(f"未配置的角色 {name}；已配置: {', '.join(CONFIG)}")

    tmp_raw = os.path.join(OUT_DIR, f"_{name}_raw.wav")
    tmp_proc = os.path.join(OUT_DIR, f"_{name}_proc.wav")
    out_mp3 = args.out or os.path.join(OUT_DIR, f"{name}.mp3")

    # 1) 拿到原始音频
    if args.src:
        print(f"[{name}] 来源: {args.src}")
        y, sr = decode_any(args.src, tmp_raw)
    else:
        voice_prompt, text = CONFIG[name]
        print(f"[{name}] {text}")
        with open(tmp_raw, "wb") as f:
            f.write(tts(text, voice_prompt))
        sr, y = wavfile.read(tmp_raw)

    # 2) 后处理
    if args.raw:
        print("  跳过后期处理（--raw）")
        x = y.astype(np.float32)
        if np.abs(x).max() > 1.5:
            x = x / 32768.0
        if x.ndim > 1:
            x = x.mean(axis=1)
        x = x / (np.abs(x).max() + 1e-9) * 0.92
    else:
        print(f"  后期处理: 合唱×2 → EQ → 轻饱和 → 暗色混响×2 "
              f"(尾巴 {args.tail_ms if args.tail_ms is not None else 'auto'}ms, "
              f"淡出 {args.fade_ms}ms)")
        x = process(y, sr, tail_ms=args.tail_ms, fade_ms=args.fade_ms)
    wavfile.write(tmp_proc, sr, (x * 32767).astype(np.int16))

    # 3) 响度归一化到与现有 11 段一致
    if args.no_normalize:
        print("  跳过响度归一化")
        os.replace(tmp_proc, out_mp3) if out_mp3.endswith(".wav") else \
            subprocess.run([FFMPEG, "-y", "-i", tmp_proc, "-b:a", "192k", out_mp3],
                           capture_output=True, check=True)
    else:
        print(f"  响度归一化到 {TARGET_LUFS} LUFS / {TARGET_TP} dBTP")
        normalize(tmp_proc, out_mp3)

    for t in (tmp_raw, tmp_proc):
        if os.path.exists(t):
            os.remove(t)

    # 4) 报告 —— 直接能和现有 11 段对比
    meas = measure_loudness(out_mp3)
    dur = probe_duration(out_mp3)
    print(f"  -> {out_mp3}")
    print(f"     时长 {dur:.2f}s   响度 {float(meas['input_i']):.2f} LUFS   "
          f"真峰值 {float(meas['input_tp']):.2f} dBTP")
    print(f"     （现有 11 段: -16.44 ~ -17.00 LUFS；"
          f"VOICES['{name}'] = {dur:.2f}）")


if __name__ == "__main__":
    main()
