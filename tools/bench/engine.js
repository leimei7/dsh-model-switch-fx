/**
 * KIKI 开机仪式 · 音频引擎
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 这是**试听台的引擎**，不是最终放进插件的代码 —— 但结构就是最终的结构：
 * 每个声音事件都写死在动画的**精确时刻**上，不是做一段音乐铺上去。
 *
 * 「质感高于 logo 音效」在这里的含义：
 *   · logo 音效是 24kHz **单声道**；这里是 AudioContext 默认（通常 48kHz）**立体声**
 *   · logo 音效走一条刻意的 lo-fi 链（band .55 / bits 5 / wow .06）—— 那是为"复古"服务的
 *   · 这里**松开**那些参数，只在需要"老"的时候局部加回去
 *
 * ── 时间轴（和 lib/client.js 的启动动画一一对应）─────────────────────────
 *   0.10–1.35  A+B 同步画线稿     → 绘制层：随进度上升的细噪 + 高音
 *   1.38–1.72  × 落下             → 一次实音（全曲最"重"的一击）
 *   1.74–1.90  气口               → **静音**。现有 logo 音效没有留白，这是开机仪式最贵的资产
 *   1.90–2.56  通电               → 低频涌入 + 谐波一层层亮起
 *   2.00–2.50  字标逐格锁定 ×11   → 11 下小咔哒，**和字标一格一格对应**
 *   2.72–4.32  定格 1.6s          → 底噪铺住 + 一句人声
 *
 * ── 三个方向 ────────────────────────────────────────────────────────────
 *   A 通电        冷、准、有秩序。适合"这是一台精密设备"
 *   B 被迎接      暖、亲密。**和美术专家给的情感目标直接对应**
 *   C 远方的信号  复古未来。从窄带噪声里慢慢变清晰
 *
 * 改这个文件 → 刷新页面就生效（试听台每个请求都重新读盘）。
 */
(function (global) {
  'use strict'

  // ── 事件时间轴 ──────────────────────────────────────────────────────────
  // 面板上会把这些画成刻度，让你知道"正在听的是哪一下"。
  var CUE = [
    { t: 0.05, label: '房间醒来', kind: 'onset' },
    { t: 0.10, label: '绘制开始 A+B 同步', kind: 'bed', dur: 1.25 },
    { t: 1.38, label: '× 落下', kind: 'hit' },
    { t: 1.74, label: '气口 · 静音', kind: 'silence', dur: 0.16 },
    { t: 1.90, label: '通电', kind: 'hit' },
    { t: 2.00, label: '字标锁定 ×11', kind: 'ticks', dur: 0.50 },
    { t: 2.72, label: '定格', kind: 'bed', dur: 1.60 },
    { t: 2.95, label: '人声', kind: 'voice' }
  ]

  // ── 工具 ────────────────────────────────────────────────────────────────
  function mulberry(seed) {
    var a = seed >>> 0
    return function () {
      a = (a + 0x6D2B79F5) >>> 0
      var t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /** 音阶 —— 三个方向用不同的调式，这是它们"性格"的一半。 */
  var SCALE = {
    fifths: [0, 7, 12, 19, 24],                       // 纯五度堆叠：空、准、无情绪
    major: [0, 4, 7, 11, 14, 16],                     // 大调：暖、亲密
    dorian: [0, 2, 3, 7, 9, 10, 14]                   // 多利亚：复古未来那点"旧调"的味道
  }
  function noteHz(root, scale, i) {
    var s = SCALE[scale]
    var semi = s[((i % s.length) + s.length) % s.length] + 12 * Math.floor(i / s.length)
    return root * Math.pow(2, semi / 12)
  }

  /** 立体声混响脉冲 —— 衰减噪声，低通。dark 越小越暗。 */
  function makeIR(ctx, dur, dark, seed) {
    var n = Math.max(1, Math.floor(ctx.sampleRate * dur))
    var ir = ctx.createBuffer(2, n, ctx.sampleRate)
    for (var ch = 0; ch < 2; ch++) {
      var d = ir.getChannelData(ch)
      var rnd = mulberry(seed + ch * 977)
      // 一阶低通，越往后越暗（高频先死 —— 真实房间就是这样）
      var y = 0
      for (var i = 0; i < n; i++) {
        var k = i / n
        var a = Math.min(1, (2 * Math.PI * dark * (1 - 0.6 * k)) / ctx.sampleRate)
        y += a * (rnd() * 2 - 1 - y)
        d[i] = y * Math.pow(1 - k, 2.2)
      }
      // 前 6ms 藏一个直达尖，让混响不糊住起音
      var pre = Math.floor(ctx.sampleRate * 0.006)
      for (var j = 0; j < pre && j < n; j++) d[j] *= j / pre
    }
    return ir
  }

  /** 母线：软限幅 + 一点点胶合。所有方向共用。 */
  function makeBus(ctx) {
    var input = ctx.createGain()
    var shaper = ctx.createWaveShaper()
    var n = 1024, curve = new Float32Array(n)
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1
      curve[i] = Math.tanh(x * 1.25) / Math.tanh(1.25)
    }
    shaper.curve = curve
    input.connect(shaper)
    return { input: input, out: shaper }
  }

  /** 一个音：起音 / 保持 / 指数释放。pan 是立体声位置。 */
  function tone(ctx, dest, o) {
    var t = o.t, dur = o.dur, atk = o.atk == null ? 0.006 : o.atk
    var osc = ctx.createOscillator()
    osc.type = o.type || 'sine'
    osc.frequency.setValueAtTime(o.f, t)
    if (o.glide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.glide), t + dur)

    var g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t + atk)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)

    var node = osc
    if (o.band) {
      var f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = o.band
      f.Q.value = o.q == null ? 1.2 : o.q
      node.connect(f); node = f
    }
    node.connect(g)
    if (o.pan != null && ctx.createStereoPanner) {
      var p = ctx.createStereoPanner()
      p.pan.value = o.pan
      g.connect(p); p.connect(dest)
    } else {
      g.connect(dest)
    }
    osc.start(t)
    osc.stop(t + dur + 0.02)
    return osc
  }

  /** 噪声：可带通、可扫频。 */
  function makeNoise(ctx, seconds, seed) {
    var n = Math.floor(ctx.sampleRate * seconds)
    var b = ctx.createBuffer(2, n, ctx.sampleRate)
    for (var ch = 0; ch < 2; ch++) {
      var d = b.getChannelData(ch), rnd = mulberry(seed + ch * 613)
      for (var i = 0; i < n; i++) d[i] = rnd() * 2 - 1
    }
    return b
  }

  function noise(ctx, dest, buf, o) {
    var t = o.t, dur = o.dur
    var src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    src.playbackRate.value = o.rate || 1

    var f = ctx.createBiquadFilter()
    f.type = o.type || 'bandpass'
    f.frequency.setValueAtTime(o.lo, t)
    if (o.hi) f.frequency.exponentialRampToValueAtTime(Math.max(30, o.hi), t + dur)
    f.Q.value = o.q == null ? 1.0 : o.q

    var g = ctx.createGain()
    var atk = o.atk == null ? 0.01 : o.atk
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t + atk)
    if (o.hold) g.gain.setValueAtTime(Math.max(0.0002, o.gain), t + o.hold)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)

    src.connect(f); f.connect(g)
    if (o.pan != null && ctx.createStereoPanner) {
      var p = ctx.createStereoPanner()
      p.pan.value = o.pan
      g.connect(p); p.connect(dest)
    } else g.connect(dest)
    src.start(t, o.offset || 0)
    src.stop(t + dur + 0.02)
    return src
  }

  // ── 三个方向 ────────────────────────────────────────────────────────────
  // 参数就是"性格"：起音的软硬、调式、底噪的质地、房间的大小与明暗。
  var PRESET = {
    A: {
      name: '通电',
      blurb: '冷、准、有秩序 —— 仪器自检。适合"这是一台精密设备"',
      root: 220, scale: 'fifths',
      onset: { kind: 'relay', atk: 0.002, gain: 0.16 },
      room: { dur: 1.0, dark: 7000, mix: 0.20, seed: 11 },
      noiseKind: 'hiss', noiseGain: 0.045,
      drawGain: 0.05, drawAtk: 0.30,
      crossGain: 0.30, crossType: 'triangle', crossF: 110,
      heatGain: 0.22,
      tickGain: 0.085, tickKind: 'relay',
      holdGain: 0.030, holdAtk: 0.6,
      voicePan: 0
    },
    B: {
      name: '被迎接',
      blurb: '暖、亲密 —— 底噪像屋子本来就有的安静，起音像布料和木头（美术专家定的情感目标）',
      root: 174.6, scale: 'major',
      onset: { kind: 'felt', atk: 0.055, gain: 0.13 },
      room: { dur: 2.4, dark: 2400, mix: 0.36, seed: 23 },
      noiseKind: 'room', noiseGain: 0.055,
      drawGain: 0.038, drawAtk: 0.55,
      crossGain: 0.24, crossType: 'sine', crossF: 87.3,
      heatGain: 0.19,
      tickGain: 0.055, tickKind: 'felt',
      holdGain: 0.034, holdAtk: 1.1,
      voicePan: 0.1
    },
    C: {
      name: '远方的信号',
      blurb: '复古未来 —— 从窄带噪声里慢慢变清晰，和 CRT 屏幕同一种调性',
      root: 196, scale: 'dorian',
      onset: { kind: 'lock', atk: 0.012, gain: 0.14 },
      room: { dur: 1.7, dark: 3400, mix: 0.30, seed: 37 },
      noiseKind: 'shortwave', noiseGain: 0.075,
      drawGain: 0.055, drawAtk: 0.35,
      crossGain: 0.27, crossType: 'sawtooth', crossF: 98,
      heatGain: 0.21,
      tickGain: 0.07, tickKind: 'lock',
      holdGain: 0.032, holdAtk: 0.8,
      voicePan: -0.1
    }
  }

  // ── 起音 / 咔哒：三个方向的性格差异主要在这里 ──────────────────────────
  function onset(ctx, dest, P, t, noiseBuf) {
    var o = P.onset
    if (o.kind === 'relay') {
      // 继电器：几乎无起音时间、干脆
      tone(ctx, dest, { t: t, f: P.root * 2, dur: 0.16, type: 'triangle', gain: o.gain, atk: o.atk })
      noise(ctx, dest, noiseBuf, { t: t, dur: 0.05, lo: 2600, gain: o.gain * 0.5, q: 0.8, atk: 0.001 })
    } else if (o.kind === 'felt') {
      // 布料/木头：慢起音 + 低通噪声，没有金属感
      tone(ctx, dest, { t: t, f: P.root, dur: 0.9, type: 'sine', gain: o.gain, atk: o.atk,
        glide: P.root * 0.98 })
      noise(ctx, dest, noiseBuf, { t: t, dur: 0.5, type: 'lowpass', lo: 420, gain: o.gain * 0.7,
        atk: o.atk, q: 0.7 })
    } else {
      // 信号锁定：一声短扫频 + 咔
      noise(ctx, dest, noiseBuf, { t: t, dur: 0.28, lo: 380, hi: 2400, gain: o.gain * 0.55,
        q: 4, atk: o.atk })
      tone(ctx, dest, { t: t, f: P.root * 3, dur: 0.10, type: 'square', gain: o.gain * 0.35,
        atk: 0.002, band: 1500 })
    }
  }

  function tick(ctx, dest, P, t, i, noiseBuf) {
    var k = P.tickKind
    var n = noteHz(P.root, P.scale, i % 5) * 2   // 11 下走一遍音阶
    if (k === 'relay') {
      tone(ctx, dest, { t: t, f: n, dur: 0.075, type: 'triangle', gain: P.tickGain, atk: 0.0015,
        pan: (i / 10) * 1.7 - 0.85 })
    } else if (k === 'felt') {
      tone(ctx, dest, { t: t, f: n * 0.5, dur: 0.16, type: 'sine', gain: P.tickGain, atk: 0.012,
        pan: (i / 10) * 1.0 - 0.5 })
      noise(ctx, dest, noiseBuf, { t: t, dur: 0.09, type: 'lowpass', lo: 700,
        gain: P.tickGain * 0.6, atk: 0.008, pan: (i / 10) * 1.0 - 0.5 })
    } else {
      noise(ctx, dest, noiseBuf, { t: t, dur: 0.10, lo: 900, hi: 2600, gain: P.tickGain * 0.8,
        q: 3, atk: 0.003, pan: (i / 10) * 1.1 - 0.55 })
    }
  }

  // ── 主调度 ──────────────────────────────────────────────────────────────
  /**
   * 把一整段排进 AudioContext。
   * @param ctx   AudioContext（或 OfflineAudioContext）
   * @param id    'A' | 'B' | 'C'
   * @param t0    动画 t=0 对应的 ctx.currentTime
   * @param opts  { voice: AudioBuffer|null, voiceGain }
   * @returns { bus, master }
   */
  function render(ctx, id, t0, opts) {
    opts = opts || {}
    var P = PRESET[id]
    var bus = makeBus(ctx)
    var master = ctx.createGain()
    master.gain.value = opts.master == null ? 1 : opts.master

    // 房间混响（并行）
    var conv = ctx.createConvolver()
    conv.buffer = makeIR(ctx, P.room.dur, P.room.dark, P.room.seed)
    var wet = ctx.createGain(); wet.gain.value = P.room.mix
    var dry = ctx.createGain(); dry.gain.value = 1
    bus.out.connect(dry); dry.connect(master)
    bus.out.connect(conv); conv.connect(wet); wet.connect(master)

    var nbuf = makeNoise(ctx, 3.0, 99 + P.room.seed)

    function at(t) { return t0 + t }

    // ① 房间醒来
    onset(ctx, bus.input, P, at(0.05), nbuf)

    // ② 绘制层：0.10 → 1.35，一条随进度上升的细噪 + 一个缓慢升高的高音
    noise(ctx, bus.input, nbuf, {
      t: at(0.10), dur: 1.25, lo: 1800, hi: 5200, gain: P.drawGain,
      q: 1.6, atk: P.drawAtk, pan: -0.42
    })
    noise(ctx, bus.input, nbuf, {
      t: at(0.10), dur: 1.25, lo: 900, hi: 2100, gain: P.drawGain * 0.7,
      q: 2.2, atk: P.drawAtk, pan: 0.42
    })
    // 一个很轻的高音跟着画（不是旋律，是"笔在动"）
    for (var i = 0; i < 5; i++) {
      var tt = 0.16 + i * 0.24
      tone(ctx, bus.input, {
        t: at(tt), f: noteHz(P.root, P.scale, i + 2) * 4,
        dur: 0.34, type: 'sine', gain: P.drawGain * 0.5, atk: 0.06,
        pan: (i % 2 ? 0.62 : -0.62)
      })
    }

    // ③ × 落下：全曲最重的一击（1.38）
    // **必须在 1.74 之前收干净** —— 第一版 dur 给了 0.55（到 1.93），
    // 尾巴整个盖住了气口，把留白填掉了。留白是整段最贵的东西，不能填。
    // 缩短之后，混响尾巴自己衰减出去 —— 那才是"空间"，不是"声音"。
    tone(ctx, bus.input, {
      t: at(1.38), f: P.crossF, dur: 0.32, type: P.crossType,
      gain: P.crossGain, atk: 0.004, glide: P.crossF * 0.62
    })
    noise(ctx, bus.input, nbuf, {
      t: at(1.38), dur: 0.16, lo: 140, hi: 900, gain: P.crossGain * 0.5,
      type: 'lowpass', atk: 0.003
    })
    tone(ctx, bus.input, {
      t: at(1.40), f: noteHz(P.root, P.scale, 3), dur: 0.28,
      type: 'sine', gain: P.crossGain * 0.4, atk: 0.02, pan: 0.45
    })

    // ④ 气口 1.74–1.90 —— **什么都不排**。只剩上一下的混响在衰减。

    // ⑤ 通电 1.90：低频涌入 + 谐波一层层亮起
    tone(ctx, bus.input, {
      t: at(1.90), f: P.root * 0.5, dur: 1.05, type: 'sine',
      gain: P.heatGain, atk: 0.09, glide: P.root * 0.5
    })
    for (var h = 0; h < 4; h++) {
      tone(ctx, bus.input, {
        t: at(1.92 + h * 0.075), f: noteHz(P.root, P.scale, h),
        dur: 0.95 - h * 0.06, type: 'sine',
        gain: P.heatGain * (0.50 - h * 0.075), atk: 0.05 + h * 0.03,
        pan: (h % 2 ? 0.55 : -0.55)
      })
    }
    noise(ctx, bus.input, nbuf, {
      t: at(1.90), dur: 0.66, lo: 260, hi: 3000, gain: P.noiseGain * 0.8,
      q: 1.1, atk: 0.14
    })

    // ⑥ 字标：11 下，和格子一一对应（2.00 起，步长 0.05）
    for (var k = 0; k < 11; k++) tick(ctx, bus.input, P, at(2.00 + k * 0.05), k, nbuf)

    // ⑦ 定格：底噪铺住，一直到结束
    noise(ctx, bus.input, nbuf, {
      t: at(2.70), dur: 1.62, lo: 120, gain: P.holdGain,
      type: P.noiseKind === 'hiss' ? 'highpass' : 'lowpass',
      atk: P.holdAtk, q: 0.6
    })

    // ⑧ 人声（如果有）
    if (opts.voice) {
      var src = ctx.createBufferSource()
      src.buffer = opts.voice
      var vg = ctx.createGain()
      vg.gain.value = opts.voiceGain == null ? 0.9 : opts.voiceGain
      src.connect(vg)
      if (ctx.createStereoPanner && P.voicePan) {
        var vp = ctx.createStereoPanner()
        vp.pan.value = P.voicePan
        vg.connect(vp); vp.connect(master)
      } else vg.connect(master)
      src.start(at(2.95))
    }

    master.connect(ctx.destination)
    return { bus: bus, master: master }
  }

  global.KikiBench = { CUE: CUE, PRESET: PRESET, render: render, makeNoise: makeNoise }
})(window)
