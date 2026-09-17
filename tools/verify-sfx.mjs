/**
 * 客观校验 sfx-lab 的合成结果：
 *   1) 每段旋律都非静音
 *   2) 每个音的实际音高 = 设计音高（自相关测周期）
 *   3) 脉冲波的谐波幅度 = 傅里叶级数 2/(nπ)·sin(nπ·d)  ← 证明构造是对的
 *
 * 用法: node tools/verify-sfx.mjs
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHROME = process.env.DSH_FX_CHROME ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome')
const LAB = pathToFileURL(join(process.cwd(), 'tools', 'sfx-lab.html')).href
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=9345',
  `--user-data-dir=${join(process.env.TEMP, 'cdp-sfx')}`,
  '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,900', LAB,
], { stdio: 'ignore' })

let list = null
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:9345/json/list')).json(); if (list?.length) break } catch {}
  await sleep(300)
}
const page = list.find((t) => t.type === 'page' && t.url.startsWith('file:')) ?? list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++seq
  pending.set(mid, { res, rej })
  ws.send(JSON.stringify({ id: mid, method, params }))
})
await new Promise((r) => ws.addEventListener('open', r))
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id)
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
  }
})
await send('Runtime.enable')
for (let i = 0; i < 40; i++) {
  const r = await send('Runtime.evaluate', { expression: 'typeof window.__lab', returnByValue: true })
  if (r.result.value === 'object') break
  await sleep(200)
}

const evalIn = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result.value
}

/* ── 在 Node 里做 DSP ─────────────────────────────────────────────────── */
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)

/**
 * 自相关测基频。
 *
 * 两个陷阱都要躲开：
 *   - 只取全局最大值 → 周期信号在 2×周期处同样有峰，会得到**低八度**（500Hz 量成 250Hz）
 *   - 只用「第一个超过 x×最大值」的阈值 → 会落在峰的肩膀上（500Hz 量成 516Hz）
 * 所以取「**第一个达到 0.9×最大值、且是局部峰**」的那个 lag。
 */
function pitch(a, sr) {
  const n = Math.min(a.length, Math.floor(sr * 0.03))
  const seg = a.slice(0, n)
  const mean = seg.reduce((s, v) => s + v, 0) / n
  const x = seg.map((v) => v - mean)
  const lo = Math.floor(sr / 2000), hi = Math.floor(sr / 150)
  if (hi + 1 >= x.length) return 0
  const ac = new Float64Array(hi + 2)
  let best = 0
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag]
    ac[lag] = s / (x.length - lag)
    if (ac[lag] > best) best = ac[lag]
  }
  if (best <= 0) return 0
  for (let lag = lo + 1; lag < hi; lag++) {
    if (ac[lag] >= best * 0.9 && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
      return sr / lag
    }
  }
  return 0
}

/** 指定频率处的幅度（Goertzel）。 */
function magAt(a, sr, f) {
  const w = 2 * Math.PI * f / sr
  const c = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (let i = 0; i < a.length; i++) {
    const s0 = a[i] + c * s1 - s2
    s2 = s1; s1 = s0
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / a.length
}

const SR = 48000
const C5 = 440 * Math.pow(2, (72 - 69) / 12)
const melodies = await evalIn('JSON.stringify(window.__lab.MELODIES.map(m=>({id:m.id,name:m.name,deg:m.deg,step:m.step,len:m.len})))')
const MELS = JSON.parse(melodies)

let pass = 0, fail = 0
const chk = (ok, msg) => { console.log('  ', ok ? 'ok  ' + msg : 'FAIL ' + msg); ok ? pass++ : fail++ }

console.log('\n[1] 每段旋律：非静音 + 每个音的音高正确')
for (const m of MELS) {
  const data = await evalIn(
    `window.__lab.render(${JSON.stringify(m.id)}, 0.5, ${C5}).then(a=>JSON.stringify(a))`,
    true,
  )
  const a = JSON.parse(data)
  const amp = rms(a)
  const dur = a.length / SR
  let pitchOk = 0
  const detail = []
  for (let i = 0; i < m.deg.length; i++) {
    const want = C5 * Math.pow(2, m.deg[i] / 12)
    const s = Math.floor((i * m.step + 0.006) * SR)   // 跳过起音瞬态
    const seg = a.slice(s, s + Math.floor(SR * 0.03))
    const got = pitch(seg, SR)
    const err = Math.abs(got - want) / want
    if (err < 0.04) pitchOk++
    detail.push(`${Math.round(want)}↔${Math.round(got)}`)
  }
  chk(amp > 0.02, `${m.name.padEnd(6)} 非静音 (RMS ${amp.toFixed(3)}, ${dur.toFixed(2)}s)`)
  chk(pitchOk === m.deg.length, `${m.name.padEnd(6)} 音高全对 ${pitchOk}/${m.deg.length}  ${detail.join(' ')}`)
}

console.log('\n[2] 脉冲波谐波幅度 = 傅里叶级数 2/(nπ)·sin(nπ·d)')
for (const d of [0.5, 0.25, 0.125]) {
  // 用固定音高 500Hz 渲染一个长音来分析谐波
  const data = await evalIn(`(async()=>{
    const off=new OfflineAudioContext(1, 48000, 48000)
    const g=off.createGain(); g.gain.value=1; g.connect(off.destination)
    const w=window.__lab.pulseWave(off, ${d})
    const o=off.createOscillator(); o.setPeriodicWave(w); o.frequency.value=500
    o.connect(g); o.start(0); o.stop(0.99)
    const b=await off.startRendering()
    return JSON.stringify(Array.from(b.getChannelData(0)))
  })()`, true)
  const a = JSON.parse(data)
  const seg = a.slice(Math.floor(SR * 0.1), Math.floor(SR * 0.9))
  const h = []
  for (let n = 1; n <= 6; n++) {
    const measured = magAt(seg, SR, 500 * n)
    const theory = Math.abs((2 / (n * Math.PI)) * Math.sin(n * Math.PI * d))
    h.push({ n, measured, theory })
  }
  // 比「相对基波的比值」而不是绝对值：PeriodicWave 会做整体归一化，
  // 绝对值带着一个与 duty 相关的固定缩放（约 0.33~0.38），比值则天然免掉它。
  const r = (x) => (x.theory < 1e-9 ? null : x.measured / h[0].measured)
  const rt = (x) => (x.theory < 1e-9 ? null : x.theory / h[0].theory)
  let worst = 0
  for (const x of h) {
    if (r(x) === null) continue
    worst = Math.max(worst, Math.abs(r(x) - rt(x)) / rt(x))
  }
  const evenGone = h.filter((x) => x.n % 2 === 0).every((x) => x.theory < 1e-9 || x.measured > h[0].measured * 0.02)
  chk(worst < 0.05, `duty ${(d * 100).toFixed(1)}%  谐波配比吻合（相对基波的最大误差 ${(worst * 100).toFixed(1)}%）`)
  if (d === 0.5) {
    chk(h.filter((x) => x.n % 2 === 0).every((x) => x.measured < h[0].measured * 0.02),
      'duty 50%  偶次谐波被抵消（方波的标志）')
  }
  console.log('      ' + h.map((x) => `h${x.n}:${x.measured.toFixed(3)}/${x.theory.toFixed(3)}`).join('  '))
}

console.log('\n[2b] 跨采样率的音高一致性')
console.log('     （回归：PeriodicWave 绑定创建它的 AudioContext，跨 context 复用会让音高整体乘采样率比）')
{
  const got = {}
  for (const sr of [44100, 48000]) {
    const a = JSON.parse(await evalIn(
      `window.__lab.tone(0.5, 500, ${sr}).then(x=>JSON.stringify(x))`, true))
    const from = Math.floor(sr * 0.15)
    got[sr] = pitch(a.slice(from, from + Math.floor(sr * 0.05)), sr)
  }
  const err = Math.abs(got[48000] - got[44100]) / 500
  chk(err < 0.02,
    `44100Hz / 48000Hz 渲染同一音高一致（${Math.round(got[44100])}Hz / ${Math.round(got[48000])}Hz，目标 500Hz）`)
  chk(Math.abs(got[48000] - 500) / 500 < 0.02, `绝对音高正确（${Math.round(got[48000])}Hz，目标 500Hz）`)
}

console.log('\n[3] 各角色根音（F0 单调映射到 A4~E5 后量化）')
const chars = JSON.parse(await evalIn('JSON.stringify(window.__lab.CHARS)'))
for (const [id, f0] of Object.entries(chars)) {
  const root = await evalIn(`window.__lab.charRoot(${f0})`)
  console.log(`      ${id.padEnd(11)} F0 ${String(f0).padStart(3)}Hz  ->  根音 ${root.toFixed(1)}Hz`)
}
const roots = JSON.parse(await evalIn(`JSON.stringify(Object.values(window.__lab.CHARS).map(f=>window.__lab.charRoot(f)))`))
const spread = 12 * Math.log2(Math.max(...roots) / Math.min(...roots))
chk(spread < 12, `根音跨度 ${spread.toFixed(2)} 个半音（< 1 个八度 = 同一件乐器不同键）`)

// 关键性质：单调映射 —— 相近的 F0 不能落到相差一个八度的两个音上。
// （早期用「折八度进窗口」时，329Hz→E5 而 333Hz→E4，差整整一个八度。）
{
  const pairs = Object.values(chars).map((f, i, arr) => [f, roots[i]]).sort((a, b) => a[0] - b[0])
  let worst = 0, worstAt = ''
  for (let i = 1; i < pairs.length; i++) {
    const dF0 = Math.log2(pairs[i][0] / pairs[i - 1][0])
    const dRoot = Math.abs(Math.log2(pairs[i][1] / pairs[i - 1][1])) * 12
    // 相邻 F0 相差半音以内时，根音不应跳超过 2 个半音
    if (dF0 * 12 <= 1.2 && dRoot > worst) { worst = dRoot; worstAt = `${pairs[i - 1][0]}Hz->${pairs[i][0]}Hz` }
  }
  chk(worst <= 2, `单调性：相邻 F0 内根音最大跳变 ${worst.toFixed(1)} 个半音（${worstAt || '无相近对'}）`)
}

// 逐对检查：F0 更低的角色，根音不能反而更高
{
  let inversions = 0
  for (let i = 0; i < roots.length; i++) {
    for (let j = 0; j < roots.length; j++) {
      const fi = Object.values(chars)[i], fj = Object.values(chars)[j]
      if (fi < fj && roots[i] > roots[j]) inversions++
    }
  }
  chk(inversions === 0, `单调性：${inversions} 处逆序（F0 更低却给了更高的根音）`)
}

console.log('\n[4] 试听页 UI 是否正常渲染')
await sleep(800)
{
  const ui = JSON.parse(await evalIn(`JSON.stringify({
    duty: document.querySelectorAll('#duty button').length,
    rows: document.querySelectorAll('#mel tr').length,
    chars: document.querySelectorAll('#chars button').length,
    canvas: (function(){
      const c = document.getElementById('wave')
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let lit = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++
      return lit
    })(),
    title: document.title,
  })`))
  chk(ui.duty === 4, `占空比按钮 ${ui.duty}/4`)
  chk(ui.rows === 5, `旋律候选 ${ui.rows}/5`)
  chk(ui.chars === 11, `角色按钮 ${ui.chars}/11`)
  chk(ui.canvas > 1000, `首屏波形已绘制（${ui.canvas} 个不透明像素）`)
}

console.log(`\n结果: ${pass} passed, ${fail} failed\n`)
ws.close(); child.kill(); process.exit(fail === 0 ? 0 : 1)
