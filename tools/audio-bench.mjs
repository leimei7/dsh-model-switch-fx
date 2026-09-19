/**
 * KIKI 开机仪式 · 音频试听台
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 它跑的是**真实动画**（加载真 lib/client.js，调 window.__dsfFx.boot.play()），
 * 音频引擎在 tools/bench/engine.js 里 —— **改那个文件，刷新页面就生效**
 * （这里的每个请求都重新读盘，不走缓存）。
 *
 * 用法:
 *     node tools/audio-bench.mjs [端口]        # 默认 5200
 *
 * 面板上能做的：
 *     · A / B / C 三个方向，配着真实动画听
 *     · 看事件时间轴 —— 知道"正在听的是哪一下"
 *     · 调总音量 / 人声 / 混响
 *     · **导出 WAV** —— 后面真正的创作靠这个
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientCss, VOICES } from '../lib/index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.argv[2] ?? 5200)
const BASE = '/model-switch-fx'

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KIKI 开机仪式 · 音频试听台</title>
<style>
${clientCss()}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#0b0b12;color:#8b93a7;
  font:13px/1.65 ui-monospace,Consolas,monospace}
.wrap{display:flex;flex-direction:column;min-height:100%}
header{padding:14px 20px;border-bottom:1px solid #1d1f2b;display:flex;
  align-items:baseline;gap:14px;flex-wrap:wrap}
header b{color:#dfe4f0;font-size:14px;letter-spacing:.04em}
header span{color:#4d5468;font-size:11px}
main{flex:1;display:flex;min-height:0}
#stage{flex:1;position:relative;background:#08080e;min-width:0}
.panel{width:340px;border-left:1px solid #1d1f2b;padding:16px 18px;overflow-y:auto;
  background:#0e0f16}
h4{margin:0 0 8px;font-size:11px;letter-spacing:.14em;color:#5b6172;font-weight:600;
  text-transform:uppercase}
.row{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
button{font:12px ui-monospace,Consolas,monospace;letter-spacing:.05em;cursor:pointer;
  padding:7px 13px;border-radius:6px;border:1px solid #2e3040;background:#171922;
  color:#9aa3b8}
button:hover{border-color:#4a4f68;color:#dfe4f0}
button.on{border-color:#c9a227;color:#f0d98a;background:#1d1a12}
button.go{border-color:#3a6b4a;color:#9fdcb4}
label{display:block;margin:12px 0 3px;font-size:11px;color:#5b6172}
input[type=range]{width:100%;accent-color:#c9a227}
.blurb{color:#6b7385;font-size:11px;min-height:32px;margin:0 0 10px}
.cues{border-top:1px solid #1d1f2b;margin-top:14px;padding-top:12px}
.cue{display:flex;justify-content:space-between;gap:8px;padding:2px 0;font-size:11px;
  color:#454b5e}
.cue b{color:#6b7385;font-weight:400;font-feature-settings:"tnum"}
.cue.hot{color:#f0d98a}
#meter{height:4px;background:#15161f;border-radius:2px;overflow:hidden;margin-top:10px}
#meter i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3a6b4a,#c9a227)}
#now{font-size:11px;color:#c9a227;height:16px;margin-top:6px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <b>KIKI 开机仪式 · 音频试听台</b>
    <span>动画是真的 · 引擎在 tools/bench/engine.js（改完刷新即生效）</span>
  </header>
  <main>
    <div id="stage"></div>
    <aside class="panel">
      <h4>方向</h4>
      <div class="row" id="dirs"></div>
      <p class="blurb" id="blurb"></p>

      <div class="row">
        <button class="go" id="play">▶ 播放（真动画 + 声音）</button>
        <button id="stop">■ 停</button>
      </div>
      <div id="meter"><i></i></div>
      <div id="now"></div>

      <label>总音量 <b id="vM">1.00</b></label>
      <input type="range" id="master" min="0" max="2" step="0.02" value="1">

      <label>人声 <b id="vV">0.90</b></label>
      <input type="range" id="voice" min="0" max="1.5" step="0.02" value="0.9">

      <label>混响 <b id="vR">1.00</b></label>
      <input type="range" id="room" min="0" max="2" step="0.02" value="1">

      <h4 style="margin-top:16px">人声（占位）</h4>
      <div class="row" id="voices"></div>

      <h4 style="margin-top:16px">导出</h4>
      <div class="row">
        <button id="export">⬇ 导出 WAV（整段）</button>
      </div>
      <p class="blurb" style="min-height:0">离线渲染，不改动当前听到的效果。</p>

      <div class="cues">
        <h4>事件时间轴</h4>
        <div id="cuelist"></div>
      </div>
    </aside>
  </main>
</div>

<script src="${BASE}/client.js"></script>
<script src="${BASE}/bench/engine.js"></script>
<script>
(function () {
  var AC = window.AudioContext || window.webkitAudioContext
  var ctx = null, current = null, dir = 'B'
  var voiceBuf = null, voiceId = Object.keys(${JSON.stringify(VOICES)})[0]
  var raf = null, startedAt = 0, t0Abs = 0

  var $ = function (id) { return document.getElementById(id) }

  function ensureCtx () {
    if (!ctx) ctx = new AC({ sampleRate: 48000 })
    if (ctx.state === 'suspended') ctx.resume()
    return ctx
  }

  // ── 三个方向按钮 ─────────────────────────────────────────────────────
  var PRESET = window.KikiBench.PRESET
  Object.keys(PRESET).forEach(function (k) {
    var b = document.createElement('button')
    b.textContent = k + ' · ' + PRESET[k].name
    b.dataset.k = k
    b.onclick = function () { dir = k; paint() }
    $('dirs').appendChild(b)
  })
  function paint () {
    ;[].forEach.call($('dirs').children, function (b) {
      b.className = b.dataset.k === dir ? 'on' : ''
    })
    $('blurb').textContent = PRESET[dir].blurb
    ;[].forEach.call($('cuelist').children, function (c, i) {
      c.className = 'cue'
    })
  }

  // ── 时间轴列表 ───────────────────────────────────────────────────────
  window.KikiBench.CUE.forEach(function (c) {
    var d = document.createElement('div')
    d.className = 'cue'
    d.innerHTML = '<span>' + c.label + '</span><b>' + c.t.toFixed(2) + 's</b>'
    d.dataset.t = c.t
    $('cuelist').appendChild(d)
  })

  // ── 人声（占位用的现有语音）─────────────────────────────────────────
  Object.keys(${JSON.stringify(VOICES)}).forEach(function (id) {
    var b = document.createElement('button')
    b.textContent = id
    b.dataset.id = id
    b.onclick = function () {
      voiceId = id
      ;[].forEach.call($('voices').children, function (x) {
        x.className = x.dataset.id === id ? 'on' : ''
      })
      loadVoice(id)
    }
    $('voices').appendChild(b)
  })
  ;[].forEach.call($('voices').children, function (x) {
    x.className = x.dataset.id === voiceId ? 'on' : ''
  })

  function loadVoice (id) {
    return fetch('${BASE}/voice/' + id + '.mp3')
      .then(function (r) { return r.arrayBuffer() })
      .then(function (b) { return ensureCtx().decodeAudioData(b) })
      .then(function (buf) { voiceBuf = buf })
      .catch(function () { voiceBuf = null })
  }

  // ── 播放：真动画 + 声音 ──────────────────────────────────────────────
  var T_END = 4.32

  function stop () {
    if (current) { try { current.master.disconnect() } catch (e) {} current = null }
    if (raf) { cancelAnimationFrame(raf); raf = null }
    $('now').textContent = ''
    $('meter').firstElementChild.style.width = '0%'
  }

  function play () {
    stop()
    ensureCtx()
    var lead = 0.08
    t0Abs = ctx.currentTime + lead
    startedAt = performance.now()
    // 真动画
    if (window.__dsfFx && window.__dsfFx.boot) window.__dsfFx.boot.play(true)
    // 引擎
    var keepVoice = voiceBuf
    current = window.KikiBench.render(ctx, dir, t0Abs, {
      voice: keepVoice,
      voiceGain: Number($('voice').value),
      master: Number($('master').value)
    })
    // 混响倍率（在总线上再串一个增益）
    var r = Number($('room').value)
    if (r !== 1) {
      var g = ctx.createGain(); g.gain.value = r
      current.master.disconnect()
      current.master.connect(g); g.connect(ctx.destination)
    }
    // 进度 / 刻度高亮
    function loop () {
      var t = ctx.currentTime - t0Abs
      if (t >= T_END + 1.4) { stop(); return }
      var pct = Math.max(0, Math.min(1, t / T_END))
      $('meter').firstElementChild.style.width = (pct * 100).toFixed(1) + '%'
      $('now').textContent = t < 0 ? '预备…' : ('t = ' + t.toFixed(2) + 's')
      ;[].forEach.call($('cuelist').children, function (c) {
        var ct = Number(c.dataset.t)
        c.className = 'cue' + (t >= ct && t < ct + 0.18 ? ' hot' : '')
      })
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
  }

  $('play').onclick = play
  $('stop').onclick = function () { stop(); if (window.__dsfFx && window.__dsfFx.boot) window.__dsfFx.boot.play(false) }
  ;['master', 'voice', 'room'].forEach(function (k) {
    var el = $(k)
    var out = $({ master: 'vM', voice: 'vV', room: 'vR' }[k])
    el.oninput = function () { out.textContent = Number(el.value).toFixed(2) }
  })

  // ── 导出 WAV（离线渲染，48kHz 立体声）────────────────────────────────
  function encodeWav (buf) {
    var n = buf.length, ch = buf.numberOfChannels
    var bytes = 44 + n * ch * 2
    var ab = new ArrayBuffer(bytes), v = new DataView(ab)
    function s (o, str) { for (var i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)) }
    s(0, 'RIFF'); v.setUint32(4, bytes - 8, true); s(8, 'WAVE')
    s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
    v.setUint16(22, ch, true); v.setUint32(24, buf.sampleRate, true)
    v.setUint32(28, buf.sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true)
    v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * ch * 2, true)
    var off = 44, d = []
    for (var c = 0; c < ch; c++) d.push(buf.getChannelData(c))
    for (var i = 0; i < n; i++) {
      for (var c2 = 0; c2 < ch; c2++) {
        var x = Math.max(-1, Math.min(1, d[c2][i]))
        v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7fff, true); off += 2
      }
    }
    return new Blob([ab], { type: 'audio/wav' })
  }

  $('export').onclick = function () {
    var btn = $('export')
    btn.disabled = true; btn.textContent = '渲染中…'
    var sr = 48000, dur = T_END + 1.4
    var off = new OfflineAudioContext(2, Math.ceil(sr * dur), sr)
    var keep = voiceBuf
    window.KikiBench.render(off, dir, 0.1, {
      voice: keep, voiceGain: Number($('voice').value), master: Number($('master').value)
    })
    off.startRendering().then(function (buf) {
      var a = document.createElement('a')
      a.href = URL.createObjectURL(encodeWav(buf))
      a.download = 'kiki-boot-' + dir + '.wav'
      a.click()
      btn.disabled = false; btn.textContent = '⬇ 导出 WAV（整段）'
    })
  }

  // 默认锁定第一个方向
  paint()
  loadVoice(voiceId)
  $('blurb').textContent = PRESET[dir].blurb
})()
</script>
</body>
</html>`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname

  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
    return
  }

  // 真动画脚本 —— 每次读盘，改了刷新就生效
  if (path === `${BASE}/client.js`) {
    const body = readFileSync(join(ROOT, 'lib', 'client.js'))
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
    return
  }

  // **音频引擎** —— 每次读盘。音乐创作改的就是这个文件。
  if (path === `${BASE}/bench/engine.js`) {
    const f = join(ROOT, 'tools', 'bench', 'engine.js')
    const body = readFileSync(f)
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
    return
  }

  const voice = /^\/model-switch-fx\/voice\/([a-z0-9-]+)\.mp3$/.exec(path)
  if (voice !== null && Object.prototype.hasOwnProperty.call(VOICES, voice[1])) {
    const body = readFileSync(join(ROOT, 'assets', `${voice[1]}.mp3`))
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(body.length) })
    res.end(body)
    return
  }

  const asset = /^\/model-switch-fx\/([a-z0-9_-]+\.(?:png|wav|jpg|webp))$/.exec(path)
  if (asset !== null) {
    const f = join(ROOT, 'assets', asset[1])
    if (existsSync(f)) {
      const type = { png: 'image/png', wav: 'audio/wav', jpg: 'image/jpeg', webp: 'image/webp' }
      const body = readFileSync(f)
      res.writeHead(200, {
        'content-type': type[asset[1].split('.').pop()] ?? 'application/octet-stream',
        'content-length': String(body.length),
      })
      res.end(body)
      return
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`音频试听台: http://127.0.0.1:${PORT}/`)
  console.log(`引擎（改这个）: tools/bench/engine.js`)
})
