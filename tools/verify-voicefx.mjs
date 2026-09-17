/**
 * 客观校验 tools/voice-fx-lab.html 的复古音频链：
 * 每个环节都必须**真的改变信号**，而且要量得出来 —— 不靠耳朵。
 *
 *   [1] UI 渲染正常
 *   [2] 窄带：低频与高频能量真的被削掉
 *   [3] 饱和：谐波失真（THD）真的上升
 *   [4] 位深：输出不同采样值个数塌缩
 *   [5] 抖动：瞬时音高的抖动真的出现（调制延迟）
 *   [6] 小空间：声源停止后的尾巴能量上升
 *   [7] 机械底噪：静音段的本底 RMS 上升
 *   [8] 预设单调性：从干到极重，失真度与窄带度单调上升
 *
 * 用法: node tools/verify-voicefx.mjs
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHROME = process.env.DSH_FX_CHROME ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome')
const LAB = pathToFileURL(join(process.cwd(), 'tools', 'voice-fx-lab.html')).href
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=9346',
  `--user-data-dir=${join(process.env.TEMP, 'cdp-vfx')}`,
  '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--allow-file-access-from-files',
  '--window-size=1280,900', LAB,
], { stdio: 'ignore' })

let list = null
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:9346/json/list')).json(); if (list?.length) break } catch {}
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
  const r = await send('Runtime.evaluate', { expression: 'typeof window.__vlab', returnByValue: true })
  if (r.result.value === 'object') break
  await sleep(200)
}
const evalIn = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result.value
}

/* ── DSP ─────────────────────────────────────────────────────────────── */
const SR = 44100
const rms = (a, from = 0, to = a.length) => {
  let s = 0
  for (let i = from; i < to; i++) s += a[i] * a[i]
  return Math.sqrt(s / Math.max(1, to - from))
}
/** Goertzel：指定频率处的幅度。 */
function magAt(a, sr, f, from = 0, to = a.length) {
  const w = 2 * Math.PI * f / sr
  const c = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (let i = from; i < to; i++) { const s0 = a[i] + c * s1 - s2; s2 = s1; s1 = s0 }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / (to - from)
}
/** 分频段能量（用 Goertzel 扫若干点求均值）。 */
function bandEnergy(a, sr, lo, hi, points = 24, from = 0, to = a.length) {
  let s = 0
  for (let i = 0; i < points; i++) {
    const f = lo * Math.pow(hi / lo, i / (points - 1))
    s += magAt(a, sr, f, from, to) ** 2
  }
  return Math.sqrt(s / points)
}
/** 自相关测基频（取最短的显著局部峰，避免低八度）。 */
function pitch(a, sr, from) {
  const n = Math.min(Math.floor(sr * 0.025), a.length - from)
  if (n < 128) return 0
  const seg = a.slice(from, from + n)
  const mean = seg.reduce((s, v) => s + v, 0) / n
  const x = seg.map((v) => v - mean)
  const lo = Math.floor(sr / 1200), hi = Math.floor(sr / 180)
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
    if (ac[lag] >= best * 0.9 && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) return sr / lag
  }
  return 0
}

let pass = 0, fail = 0
const chk = (ok, msg) => { console.log('  ', ok ? 'ok  ' + msg : 'FAIL ' + msg); ok ? pass++ : fail++ }

const PRESETS = JSON.parse(await evalIn('JSON.stringify(window.__vlab.PRESETS)'))
const DRY = JSON.parse(await evalIn('JSON.stringify(window.__vlab.DEFAULTS)'))
const DUR = 1.4, SRC = 0.7        // 声源 0.7s，总长 1.4s（留 0.7s 尾巴量混响/底噪）

/** 用给定参数离线渲染一段纯音过链。 */
const render = async (p) => JSON.parse(await evalIn(
  `window.__vlab.renderTest(${JSON.stringify(p)}, ${DUR}, ${SR}, ${SRC}).then(r=>JSON.stringify(r))`,
  true))

/* [1] UI ─────────────────────────────────────────────────────────────── */
console.log('\n[1] 试听页 UI')
{
  const ui = JSON.parse(await evalIn(`JSON.stringify({
    presets: document.querySelectorAll('#presets button').length,
    chars: document.querySelectorAll('#chars button').length,
    stages: document.querySelectorAll('#stages tr').length,
    sliders: document.querySelectorAll('#stages input[type=range]').length,
  })`))
  chk(ui.presets === PRESETS.length, `预设按钮 ${ui.presets}/${PRESETS.length}`)
  chk(ui.chars === 11, `角色按钮 ${ui.chars}/11`)
  chk(ui.stages === 6, `环节行 ${ui.stages}/6（窄带/饱和/位深/抖动/小空间/底噪）`)
  chk(ui.sliders === 6, `强度滑杆 ${ui.sliders}/6`)
}

const dry = await render(DRY)
const drySamples = dry.samples
const dryBandLow = bandEnergy(drySamples, SR, 60, 200)
const dryBandHigh = bandEnergy(drySamples, SR, 6000, 14000)
const dryTotal = bandEnergy(drySamples, SR, 60, 14000)
const dryTHD = (() => {
  const f = 440
  const base = magAt(drySamples, SR, f, 0, Math.floor(SR * SRC))
  let h = 0
  for (const n of [2, 3, 4, 5]) h += magAt(drySamples, SR, f * n, 0, Math.floor(SR * SRC)) ** 2
  return Math.sqrt(h) / (base + 1e-9)
})()

/* [2] 窄带 ───────────────────────────────────────────────────────────── */
console.log('\n[2] 窄带：低频与高频能量真的被削掉')
{
  const band = await render({ ...DRY, band: 0.9 })
  const s = band.samples
  const lo = bandEnergy(s, SR, 60, 200) / dryBandLow
  // 高频用 8k~14k：低端 6k 还在低通的过渡带里，混进来会把结论冲淡
  const hi = bandEnergy(s, SR, 8000, 14000) / bandEnergy(drySamples, SR, 8000, 14000)
  const mid = bandEnergy(s, SR, 500, 2500) / bandEnergy(drySamples, SR, 500, 2500)
  console.log(`   相对干声的能量比：低频 ${lo.toFixed(3)}  高频(8k~14k) ${hi.toFixed(3)}  中频 ${mid.toFixed(3)}`)
  chk(lo < 0.5, `低频被削（${lo.toFixed(3)} < 0.5）`)
  chk(hi < 0.2, `高频被削（${hi.toFixed(3)} < 0.2，约 ${(20 * Math.log10(hi)).toFixed(0)}dB）`)
  chk(mid > 0.4, `中频保留（${mid.toFixed(3)} > 0.4）—— 语音可懂度还在`)
}

/* [3] 饱和 ───────────────────────────────────────────────────────────── */
console.log('\n[3] 饱和：谐波失真（THD）真的上升')
{
  const shrp = await render({ ...DRY, drive: 0.9 })
  const f = 440
  const to = Math.floor(SR * SRC)
  const base = magAt(shrp.samples, SR, f, 0, to)
  let h = 0
  for (const n of [2, 3, 4, 5]) h += magAt(shrp.samples, SR, f * n, 0, to) ** 2
  const thd = Math.sqrt(h) / (base + 1e-9)
  console.log(`   THD：干声 ${(dryTHD * 100).toFixed(1)}% → 饱和 ${(thd * 100).toFixed(1)}%`)
  chk(thd > dryTHD * 2, `谐波失真翻倍以上（${(thd / dryTHD).toFixed(1)}×）`)
}

/* [4] 位深 ───────────────────────────────────────────────────────────── */
console.log('\n[4] 位深：输出不同采样值个数塌缩')
{
  const count = (a) => { const s = new Set(); for (const v of a) s.add(Math.round(v * 8192)); return s.size }
  const c = await render({ ...DRY, bits: 5 })
  const nDry = count(drySamples), nCrush = count(c.samples)
  console.log(`   不同采样值个数：干声 ${nDry} → 5bit ${nCrush}`)
  chk(nCrush < nDry / 3, `位深缩减生效（塌缩到 ${(nCrush / nDry * 100).toFixed(0)}%）`)
}

/* [5] 抖动 ───────────────────────────────────────────────────────────── */
console.log('\n[5] 抖动：瞬时音高真的在晃（调制延迟）')
{
  const jitter = (a) => {
    const ps = []
    for (let t = 0.1; t < SRC - 0.05; t += 0.02) {
      const f = pitch(a, SR, Math.floor(t * SR))
      if (f > 0) ps.push(f)
    }
    if (ps.length < 4) return 0
    const m = ps.reduce((s, v) => s + v, 0) / ps.length
    return Math.sqrt(ps.reduce((s, v) => s + (v - m) ** 2, 0) / ps.length) / m
  }
  const dryJ = jitter(drySamples)
  const wow = await render({ ...DRY, wow: 1 })
  const wowJ = jitter(wow.samples)
  console.log(`   音高相对抖动：干声 ${(dryJ * 100).toFixed(3)}% → 抖动 1.0 ${(wowJ * 100).toFixed(3)}%`)
  chk(wowJ > dryJ * 3 && wowJ > 0.001, `抖动明显出现（${(wowJ / Math.max(dryJ, 1e-6)).toFixed(1)}×）`)
}

/* [6] 小空间 ─────────────────────────────────────────────────────────── */
console.log('\n[6] 小空间：声源停止后的尾巴能量上升')
{
  const from = Math.floor((SRC + 0.12) * SR)
  const tailDry = rms(drySamples, from)
  const room = await render({ ...DRY, room: 0.9 })
  const tailRoom = rms(room.samples, from)
  console.log(`   尾巴 RMS：干声 ${tailDry.toFixed(5)} → 小空间 ${tailRoom.toFixed(5)}`)
  chk(tailRoom > tailDry * 3 && tailRoom > 1e-4, `混响尾巴出现（${(tailRoom / Math.max(tailDry, 1e-9)).toFixed(1)}×）`)
}

/* [7] 机械底噪 ───────────────────────────────────────────────────────── */
console.log('\n[7] 机械底噪：静音段的本底上升（含 50Hz 电流嗡鸣）')
{
  const from = Math.floor((SRC + 0.12) * SR)
  const n = await render({ ...DRY, noise: 0.9 })
  const s = n.samples
  const floorDry = rms(drySamples, from)
  const floorNoise = rms(s, from)
  const hum = magAt(s, SR, 50, from)
  console.log(`   本底 RMS：${floorDry.toFixed(5)} → ${floorNoise.toFixed(5)}；50Hz 嗡鸣幅度 ${hum.toFixed(4)}`)
  chk(floorNoise > floorDry * 5, `底噪出现（${(floorNoise / Math.max(floorDry, 1e-9)).toFixed(1)}×）`)
  chk(hum > 0.001, `50Hz 电流嗡鸣存在（${hum.toFixed(4)}）`)
}

/* [8] 预设之间的区分度 ─────────────────────────────────────────────────
   注意：**不能要求「从干到极重单调递增」** —— 这几个预设是不同性格
   （对讲机的窄带度 0.68 > 古董机的 0.5），不是一条阶梯。要求单调是我原来的
   断言写错了。这里改成三个站得住的性质：
     ① 干燥几乎不染色
     ② 每个预设都明显偏离干声（能听出差别）
     ③ 整组在「明暗」与「染色」两个轴上铺得开
   ─────────────────────────────────────────────────────────────────────── */
console.log('\n[8] 预设：干燥干净 / 每个都听得出来 / 整组铺得开')
{
  // 对数频率采样上的谱形，用来算与干声的距离
  const FREQS = []
  for (let i = 0; i < 40; i++) FREQS.push(80 * Math.pow(15000 / 80, i / 39))
  const specOf = (a) => FREQS.map((f) => magAt(a, SR, f, 0, Math.floor(SR * SRC)))
  const drySpec = specOf(drySamples)
  const dist = (s2) => {
    let num = 0, den = 0
    for (let i = 0; i < FREQS.length; i++) { num += (s2[i] - drySpec[i]) ** 2; den += drySpec[i] ** 2 }
    return Math.sqrt(num / den)
  }
  const tiltOf = (a) => bandEnergy(a, SR, 6000, 14000, 16, 0, Math.floor(SR * SRC))
    / bandEnergy(a, SR, 500, 2500, 16, 0, Math.floor(SR * SRC))

  const rows = []
  for (const ps of PRESETS) {
    const r = await render(ps.v)
    const spec = specOf(r.samples)
    rows.push({ id: ps.id, name: ps.name, dist: dist(spec), tilt: tiltOf(r.samples) })
  }
  const dryRow = rows.find((r) => r.id === 'dry')
  const tiltMax = Math.max(...rows.map((r) => r.tilt))
  for (const r of rows) {
    const rel = (r.tilt / tiltMax).toFixed(2)
    console.log(`      ${r.name.padEnd(16)} 与干声的谱距离 ${r.dist.toFixed(2)}`
      + `   明暗(相对最亮) ${rel}`)
  }
  chk(dryRow.dist < 0.02, `「干燥」几乎不染色（谱距离 ${dryRow.dist.toFixed(3)}）`)
  const others = rows.filter((r) => r.id !== 'dry')
  chk(others.every((r) => r.dist > 0.1),
    `每个预设都明显偏离干声（最小 ${Math.min(...others.map((r) => r.dist)).toFixed(2)} > 0.1）`)
  chk(tiltMax / Math.min(...rows.map((r) => r.tilt)) > 2,
    `整组在明暗轴上铺得开（最亮/最暗 = ${(tiltMax / Math.min(...rows.map((r) => r.tilt))).toFixed(1)}× > 2）`)
  // 极重那个必须比轻度脏得多，否则"极重"名不副实
  const light = rows.find((r) => r.id === 'light')
  const heavy = rows.find((r) => r.id === 'heavy')
  chk(heavy.dist > light.dist * 1.3,
    `「极重」确实比「轻度」脏得多（${heavy.dist.toFixed(2)} > ${light.dist.toFixed(2)} × 1.3）`)
}

console.log(`\n结果: ${pass} passed, ${fail} failed\n`)
ws.close(); child.kill(); process.exit(fail === 0 ? 0 : 1)
