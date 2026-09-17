/**
 * 客观校验 sfx-lab：
 *   [1] 每个候选：非静音 / 不削顶 / 总时长在 250-400ms
 *   [2] 脉冲波谐波 = 傅里叶级数 2/(nπ)·sin(nπ·d)，且 50% 占空比抵消偶次谐波
 *   [3] 每个脉冲声部的每个非滑音音符：隔离渲染后音高正确
 *   [4] 滑音：起始与终点频率正确
 *   [5] 跨采样率音高一致（回归：PeriodicWave 不能跨 AudioContext 复用）
 *   [6] 角色根音映射单调
 *   [7] 候选两两差异度（简报给的加权公式）—— 直接回答「相似度太高」
 *   [8] 试听页 UI 渲染
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result.value
}
const render = async (expr) => JSON.parse(await evalIn(`${expr}.then(a=>JSON.stringify(a))`, true))

/* ── DSP ─────────────────────────────────────────────────────────────── */
const SR = 48000
const C5 = 440 * Math.pow(2, (72 - 69) / 12)
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
const peakOf = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

/**
 * 自相关测基频。
 * 两个陷阱都要躲开：只取全局最大值 → 落到 2×周期（低八度）；只用阈值 → 落到峰肩膀。
 * 所以取「第一个达到 0.9×最大值、且是局部峰」的 lag。
 */
function pitch(a, sr) {
  const n = Math.min(a.length, Math.floor(sr * 0.03))
  if (n < 64) return 0
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
    if (ac[lag] >= best * 0.9 && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) return sr / lag
  }
  return 0
}
/** 指定频率处的幅度（Goertzel）。 */
function magAt(a, sr, f) {
  const w = 2 * Math.PI * f / sr
  const c = 2 * Math.cos(w)
  let s1 = 0, s2 = 0
  for (let i = 0; i < a.length; i++) { const s0 = a[i] + c * s1 - s2; s2 = s1; s1 = s0 }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / a.length
}

let pass = 0, fail = 0
const chk = (ok, msg) => { console.log('  ', ok ? 'ok  ' + msg : 'FAIL ' + msg); ok ? pass++ : fail++ }

const CANDS = JSON.parse(await evalIn('JSON.stringify(window.__lab.CANDIDATES)'))

/* [1] 基本健康度 ─────────────────────────────────────────────────────── */
console.log('\n[1] 每个候选：非静音 / 不削顶 / 总时长 250-400ms')
const CEIL = 0.95
const gainMap = JSON.parse(await evalIn('JSON.stringify(window.__lab.GAIN)'))
for (const c of CANDS) {
  const a = await render(`window.__lab.render(${JSON.stringify(c.id)}, null, ${C5})`)
  const evs = c.voices.flatMap((v) => v.events)
  const total = Math.max(...evs.map((e) => e[1] + e[2]))
  const amp = rms(a), pk = peakOf(a)
  const voices = c.voices.length
  const noise = c.voices.some((v) => v.kind === 'noise')
  const glide = evs.some((e) => e.length > 3)
  console.log(`   ${c.name}  ${total}ms  ${voices}声部${noise ? '+噪声' : ''}${glide ? '+滑音' : ''}`
    + `  duty ${(c.duty * 100).toFixed(1).replace(/\.0$/, '')}%  RMS ${amp.toFixed(3)}  峰值 ${pk.toFixed(3)}`
    + `  (gain ${gainMap[c.id] ?? 1})`)
  chk(amp > 0.02, `${c.name.padEnd(9)} 非静音`)
  chk(pk < 0.99, `${c.name.padEnd(9)} 不削顶（峰值 ${pk.toFixed(3)}）`)
  chk(total >= 250 && total <= 400, `${c.name.padEnd(9)} 总时长 ${total}ms 在 250-400ms 内`)
}
{
  // 位深缩减是**非线性**环节（量化器）：crush(g·x) ≠ g·crush(x)，
  // 所以「测得峰值 ÷ 当前增益」推不出原始峰值 —— 必须在**增益 1 处直接测量**。
  //   干净信号（bits=0）→ 峰值与增益严格成正比，用它算峰值上限
  //   量化后信号（bits=B）→ 用它算响度
  const bitsNow = await evalIn('window.__lab.gritBits')
  const cleanList = [], crushedList = []
  for (const c of CANDS) {
    const clean = await render(`window.__lab.render(${JSON.stringify(c.id)}, null, ${C5}, 48000, 0, true)`)
    const crushed = await render(
      `window.__lab.render(${JSON.stringify(c.id)}, null, ${C5}, 48000, ${bitsNow}, true)`)
    cleanList.push({ id: c.id, name: c.name, peak: peakOf(clean) })
    crushedList.push({ id: c.id, name: c.name, rms: rms(crushed), peak: peakOf(crushed) })
  }
  // 峰值上限留出量化台阶的余量：32 级时最高一级的门槛在 ~0.968
  const topStep = 1 - 1 / (Math.pow(2, bitsNow) - 1)
  const peakCap = Math.min(CEIL, topStep - 0.002)
  const gainMap2 = JSON.parse(await evalIn('JSON.stringify(window.__lab.GAIN)'))
  const rows = cleanList.map((c, i) => {
    const maxGain = peakCap / c.peak
    return { ...c, rms: crushedList[i].rms, maxGain, achievable: crushedList[i].rms * maxGain }
  })
  const target = Math.min(...rows.map((r) => r.achievable))
  console.log(`\n   峰值上限 ${peakCap.toFixed(3)}（${bitsNow}bit 量化后最高一级门槛 ${topStep.toFixed(3)}）`)
  console.log(`   统一目标 RMS = ${target.toFixed(3)}`)
  console.log('   推荐 GAIN（向下取整，直接填回 sfx-lab.html 的 GAIN 表）：')
  const rec = {}
  for (const r of rows) {
    rec[r.id] = Math.floor(Math.min(target / r.rms, r.maxGain) * 1000) / 1000
    console.log(`      ${r.id.padEnd(9)} ${String(rec[r.id]).padStart(6)}   `
      + `(干净峰值 ${r.peak.toFixed(3)} × gain = ${(r.peak * rec[r.id]).toFixed(3)})`)
  }
  console.log('   ' + JSON.stringify(rec))
  const dbNow = 20 * Math.log10(
    Math.max(...crushedList.map((c, i) => c.rms * (gainMap2[c.id] ?? 1)))
    / Math.min(...crushedList.map((c, i) => c.rms * (gainMap2[c.id] ?? 1))))
  chk(dbNow < 3, `${CANDS.length} 个候选响度一致（极差 ${dbNow.toFixed(2)} dB < 3）`)
  chk(crushedList.every((c) => c.rms > 0.02), '所有候选量化后仍非静音')
}

/* [2] 傅里叶级数 ─────────────────────────────────────────────────────── */
console.log('\n[2] 脉冲波谐波幅度 = 傅里叶级数 2/(nπ)·sin(nπ·d)')
for (const d of [0.5, 0.25, 0.125]) {
  const a = await render(`(async()=>{
    const off=new OfflineAudioContext(1, 48000, 48000)
    const g=off.createGain(); g.gain.value=1; g.connect(off.destination)
    const o=off.createOscillator(); o.setPeriodicWave(window.__lab.pulseWave(off, ${d}))
    o.frequency.value=500; o.connect(g); o.start(0); o.stop(0.99)
    const b=await off.startRendering(); return Array.from(b.getChannelData(0))
  })()`)
  const seg = a.slice(Math.floor(SR * 0.1), Math.floor(SR * 0.9))
  const h = []
  for (let n = 1; n <= 6; n++) {
    h.push({
      n,
      measured: magAt(seg, SR, 500 * n),
      theory: Math.abs((2 / (n * Math.PI)) * Math.sin(n * Math.PI * d)),
    })
  }
  // 比「相对基波的比值」—— PeriodicWave 有整体归一化，比值天然免掉它
  const r = (x) => x.measured / h[0].measured
  const rt = (x) => x.theory / h[0].theory
  let worst = 0
  for (const x of h) if (x.theory > 1e-9) worst = Math.max(worst, Math.abs(r(x) - rt(x)) / rt(x))
  chk(worst < 0.05, `duty ${(d * 100).toFixed(1)}%  谐波配比吻合（相对基波最大误差 ${(worst * 100).toFixed(1)}%）`)
  if (d === 0.5) {
    chk(h.filter((x) => x.n % 2 === 0).every((x) => x.measured < h[0].measured * 0.02),
      'duty 50%  偶次谐波被抵消（方波的标志）')
  }
  console.log('      ' + h.map((x) => `h${x.n}:${x.measured.toFixed(3)}/${x.theory.toFixed(3)}`).join('  '))
}

/* [3] 逐音高核对（隔离声部）───────────────────────────────────────────── */
console.log('\n[3] 每个脉冲声部的每个非滑音音符：音高正确')
for (const c of CANDS) {
  for (let vi = 0; vi < c.voices.length; vi++) {
    const v = c.voices[vi]
    if (v.kind !== 'pulse') continue
    const flat = v.events.filter((e) => e.length === 3)
    if (flat.length === 0) continue
    const a = await render(`window.__lab.renderVoice(${JSON.stringify(c.id)}, ${vi}, ${C5})`)
    const bad = []
    for (const [semi, at, len] of flat) {
      const want = C5 * Math.pow(2, semi / 12)
      const from = Math.floor((at + 6) / 1000 * SR)
      const seg = a.slice(from, from + Math.floor(Math.min(28, Math.max(12, len - 8)) / 1000 * SR))
      const got = pitch(seg, SR)
      if (!(Math.abs(got - want) / want < 0.05)) bad.push(`${Math.round(want)}↔${Math.round(got)}`)
    }
    chk(bad.length === 0, `${c.name} 声部${vi} 的 ${flat.length} 个音全对${bad.length ? ' — 错: ' + bad.join(' ') : ''}`)
  }
}

/* [4] 滑音 ───────────────────────────────────────────────────────────── */
console.log('\n[4] 滑音：确认为连续斜坡（覆盖全部滑音事件）')
{
  let tested = 0
  for (const c of CANDS) {
    for (let vi = 0; vi < c.voices.length; vi++) {
      const glides = c.voices[vi].events.filter((e) => e.length > 3)
      if (glides.length === 0) continue
      const a = await render(`window.__lab.renderVoice(${JSON.stringify(c.id)}, ${vi}, ${C5})`)
      const atMs = (ms) => Math.floor(ms / 1000 * SR)
      for (const [from, at, len, to] of glides) {
        const f0 = C5 * Math.pow(2, from / 12), f1 = C5 * Math.pow(2, to / 12)
        // 滑音音高持续变化，端点取窗只能得到平均值 —— 测**中点**与线性斜坡理论值比较
        const early = pitch(a.slice(atMs(at + 12), atMs(at + 12) + Math.floor(SR * 0.014)), SR)
        const midAt = at + len * 0.5
        const mid = pitch(a.slice(atMs(midAt - 7.5), atMs(midAt + 7.5)), SR)
        const wantMid = (f0 + f1) / 2
        const change = Math.abs(f1 - f0) / f0
        console.log(`   ${c.name} 声部${vi} 滑音 ${from}→${to} 半音（${Math.round(f0)}→${Math.round(f1)}Hz）`
          + `  实测 早期 ${Math.round(early)}  中点 ${Math.round(mid)}(理论 ${Math.round(wantMid)})`)
        chk(Math.abs(mid - wantMid) / wantMid < 0.07,
          `${c.name} 滑音中点符合线性斜坡（误差 ${(Math.abs(mid - wantMid) / wantMid * 100).toFixed(1)}%）`)
        if (change > 0.05) {
          // 变化够大才测方向；⑪ 是 5.6% 的微降，落在音高检测的分辨率边缘
          const dir = Math.sign(f1 - f0)
          chk(Math.sign(mid - early) === dir, `${c.name} 滑音方向正确（朝终点移动）`)
        } else {
          console.log(`       （总变化仅 ${(change * 100).toFixed(1)}%，跳过方向判定 —— 低于音高检测分辨率）`)
        }
        tested++
      }
    }
  }
  chk(tested >= 2, `共校验 ${tested} 个滑音事件（≥2）`)
}

/* [5] 跨采样率 ───────────────────────────────────────────────────────── */
console.log('\n[5] 跨采样率音高一致（回归：PeriodicWave 不能跨 AudioContext 复用）')
{
  const got = {}
  for (const sr of [44100, 48000]) {
    const a = await render(`window.__lab.tone(0.5, 500, ${sr})`)
    const from = Math.floor(sr * 0.15)
    got[sr] = pitch(a.slice(from, from + Math.floor(sr * 0.05)), sr)
  }
  chk(Math.abs(got[48000] - got[44100]) / 500 < 0.02,
    `44100 / 48000 渲染同一音高一致（${Math.round(got[44100])} / ${Math.round(got[48000])}Hz，目标 500Hz）`)
  chk(Math.abs(got[48000] - 500) / 500 < 0.02, `绝对音高正确（${Math.round(got[48000])}Hz）`)
}

/* [5b] 毛刺感 ───────────────────────────────────────────────────────── */
console.log('\n[5b] 毛刺/数码味：位深缩减（bit-crush）与 16 级音量台阶')
{
  const bits = await evalIn('window.__lab.gritBits')
  const steps = await evalIn('window.__lab.VOLUME_STEPS')
  console.log(`   当前输出位深 ${bits} bit（${Math.pow(2, bits)} 级），音量级数 ${steps}`)
  // 位深缩减最直接的可验证性质：输出采样值的**不同取值个数**会塌缩
  const count = (a) => {
    const s = new Set()
    for (const v of a) s.add(Math.round(v * 4096))
    return s.size
  }
  const clean = await render(`window.__lab.render('ready', null, ${C5}, 48000, 0)`)
  const crushed = await render(`window.__lab.render('ready', null, ${C5}, 48000, ${bits})`)
  const nClean = count(clean), nCrushed = count(crushed)
  console.log(`   不同采样值个数：关掉 ${nClean} → ${bits}bit ${nCrushed}`)
  chk(nCrushed < nClean / 3,
    `位深缩减真的生效（取值个数 ${nClean} → ${nCrushed}，塌缩到 ${(nCrushed / nClean * 100).toFixed(0)}%）`)

  // 音量台阶：16 级离散步进 → 包络不该是平滑的一段
  const levels = await evalIn(`(function(){
    var seen = {}
    var g = { gain: {
      setValueAtTime: function (v) { seen[Math.round(v * 10000)] = 1 },
      linearRampToValueAtTime: function () {},
      exponentialRampToValueAtTime: function () {},
    } }
    window.__lab.steppedEnvelope(g, 0, 0.3, 0.9)
    return Object.keys(seen).length
  })()`)
  console.log(`   steppedEnvelope 对 300ms 音排了 ${levels} 个不同增益值`)
  chk(levels >= 4 && levels <= steps,
    `包络是离散台阶（${levels} 级，介于 4 与 ${steps} 之间）—— 不是平滑 ramp`)
}

/* [6] 角色根音单调 ───────────────────────────────────────────────────── */
console.log('\n[6] 角色根音映射单调（A4~E5）')
{
  const chars = JSON.parse(await evalIn('JSON.stringify(window.__lab.CHARS)'))
  const ids = Object.keys(chars)
  const roots = JSON.parse(await evalIn(
    `JSON.stringify(Object.values(window.__lab.CHARS).map(f=>window.__lab.charRoot(f)))`))
  let inversions = 0
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (chars[ids[i]] < chars[ids[j]] && roots[i] > roots[j]) inversions++
    }
  }
  const spread = 12 * Math.log2(Math.max(...roots) / Math.min(...roots))
  chk(inversions === 0, `0 处逆序（F0 更低却给了更高根音）`)
  chk(spread < 12, `根音跨度 ${spread.toFixed(2)} 个半音 < 1 个八度`)
}

/* [7] 候选两两差异度 ─────────────────────────────────────────────────── */
console.log('\n[7] 分配是否一一对应 + 两两差异度')
{
  const assign = JSON.parse(await evalIn('JSON.stringify(window.__lab.ASSIGN)'))
  const chars = JSON.parse(await evalIn('JSON.stringify(window.__lab.CHARS)'))
  const used = Object.values(assign)
  console.log('    角色 → 方案：')
  for (const id of Object.keys(chars)) {
    const c = CANDS.find((x) => x.id === assign[id])
    console.log(`      ${id.padEnd(11)} → ${c ? c.name : '?'}`)
  }
  chk(Object.keys(assign).length === Object.keys(chars).length,
    `每个角色都分配了（${Object.keys(assign).length}/${Object.keys(chars).length}）`)
  chk(new Set(used).size === used.length,
    `${used.length} 个角色拿到 ${used.length} 个**互不相同**的方案（去重后 ${new Set(used).size} 个）`)
  chk(used.every((u) => CANDS.some((c) => c.id === u)), `分配的方案 id 都存在`)
  const unused = CANDS.filter((c) => !used.includes(c.id))
  console.log(`    未分配（留在方案库里备选）：${unused.length ? unused.map((c) => c.name).join('、') : '无'}`)
}
console.log('\n    d = 2.0·Δ走向 + 1.5·|声部数差|/3 + 1.5·D_IOI + 0.5·|占空比差|')
console.log('        + 1.0·Δ噪声起手 + 1.0·Δ滑音 + 1.0·D_pitch')
console.log('    （D_pitch 是我补的：简报把「音程内容」排第 4，但公式漏了它 ——')
console.log('      否则 [0,4,7,12] 与 [0,4,7,12,16] 会被判成同一内容、只差节奏。）')
{
  const feat = CANDS.map((c) => {
    const evs = c.voices.flatMap((v) => v.events)
    const total = Math.max(...evs.map((e) => e[1] + e[2]))
    const bins = new Array(16).fill(0)
    for (const e of evs) bins[Math.min(15, Math.floor(e[1] / total * 16))] = 1
    // 音程序列：取主脉冲声部（声部数最多、非噪声的那条）的音高，算相邻音程
    const pulse = c.voices.filter((v) => v.kind === 'pulse').pop()
    const seq = pulse.events.map((e) => e[0])
    const deltas = seq.slice(1).map((s, i) => s - seq[i])
    return {
      name: c.name,
      shape: c.shape,
      voices: c.voices.length,
      duty: c.duty,
      noise: c.voices.some((v) => v.kind === 'noise' && v.events[0][1] === 0) ? 1 : 0,
      glide: evs.some((e) => e.length > 3) ? 1 : 0,
      bins,
      deltas,
    }
  })
  const l1bins = (a, b) => {
    let l1 = 0
    for (let i = 0; i < 16; i++) l1 += Math.abs(a[i] - b[i])
    return l1 / Math.max(1, a.reduce((s, v) => s + v, 0) + b.reduce((s, v) => s + v, 0))
  }
  /** 音程内容距离：相邻音程序列补零对齐后取平均绝对差，除以 12 归一到 ~[0,1]。 */
  const dPitch = (a, b) => {
    const n = Math.max(a.length, b.length)
    if (n === 0) return 0
    let s = 0
    for (let i = 0; i < n; i++) s += Math.abs((a[i] ?? 0) - (b[i] ?? 0))
    return Math.min(1, s / n / 12)
  }
  const pairs = []
  for (let i = 0; i < feat.length; i++) {
    for (let j = i + 1; j < feat.length; j++) {
      const a = feat[i], b = feat[j]
      const d = 2.0 * (a.shape === b.shape ? 0 : 1)
        + 1.5 * Math.abs(a.voices - b.voices) / 3
        + 1.5 * l1bins(a.bins, b.bins)
        + 0.5 * Math.abs(a.duty - b.duty)
        + 1.0 * Math.abs(a.noise - b.noise)
        + 1.0 * Math.abs(a.glide - b.glide)
        + 1.0 * dPitch(a.deltas, b.deltas)
      pairs.push({ i, j, d })
    }
  }
  pairs.sort((x, y) => x.d - y.d)
  console.log('    最相似的 5 对：')
  for (const p of pairs.slice(0, 5)) {
    const a = feat[p.i], b = feat[p.j]
    const why = []
    if (a.shape === b.shape) why.push('同走向')
    if (a.voices === b.voices) why.push('同声部数')
    if (a.duty === b.duty) why.push('同占空比')
    console.log(`      ${p.d.toFixed(2)}  ${a.name} ↔ ${b.name}   ${why.length ? '(' + why.join('/') + ' 相同)' : ''}`)
  }
  console.log('    最不相似的 3 对：')
  for (const p of pairs.slice(-3)) {
    console.log(`      ${p.d.toFixed(2)}  ${feat[p.i].name} ↔ ${feat[p.j].name}`)
  }
  const min = pairs[0].d, avg = pairs.reduce((s, p) => s + p.d, 0) / pairs.length
  const identicalRhythm = []
  for (let i = 0; i < CANDS.length; i++) {
    for (let j = i + 1; j < CANDS.length; j++) {
      if (CANDS[i].shape === CANDS[j].shape && l1bins(feat[i].bins, feat[j].bins) < 0.01) {
        identicalRhythm.push(`${CANDS[i].name}↔${CANDS[j].name}`)
      }
    }
  }
  console.log(`    最小 ${min.toFixed(2)}  平均 ${avg.toFixed(2)}  最大 ${pairs[pairs.length - 1].d.toFixed(2)}`)
  chk(min > 1.0, `没有「换皮不换骨」的方案（最小成对距离 ${min.toFixed(2)} > 1.0，简报经验阈值）`)
  chk(identicalRhythm.length === 0,
    `没有走向+节奏双同的方案${identicalRhythm.length ? ' — 违规: ' + identicalRhythm.join(', ') : ''}`)
  chk(new Set(feat.map((f) => f.shape)).size >= 5, `走向覆盖 ${new Set(feat.map((f) => f.shape)).size} 类（≥5）`)
  chk(new Set(feat.map((f) => f.voices)).size >= 2, `声部数覆盖 ${new Set(feat.map((f) => f.voices)).size} 档`)
  chk(new Set(feat.map((f) => f.duty)).size >= 3, `占空比覆盖 ${new Set(feat.map((f) => f.duty)).size} 档`)
}

/* [8] UI ─────────────────────────────────────────────────────────────── */
console.log('\n[8] 试听页 UI')
await sleep(700)
{
  const ui = JSON.parse(await evalIn(`JSON.stringify({
    assignRows: document.querySelectorAll('#assign tr').length,
    libRows: document.querySelectorAll('#lib tr').length,
    playAll: !!document.getElementById('playAll'),
    assignButtons: document.querySelectorAll('#assign button').length,
    libButtons: document.querySelectorAll('#lib button').length,
    canvas: (function(){const c=document.getElementById('wave')
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data
      let n=0; for(let i=3;i<d.length;i+=4) if(d[i]>0) n++; return n})(),
  })`))
  const nChars = Object.keys(JSON.parse(await evalIn('JSON.stringify(window.__lab.CHARS)'))).length
  chk(ui.assignRows === nChars, `角色→方案 表 ${ui.assignRows}/${nChars} 行`)
  chk(ui.assignButtons === nChars, `角色试听按钮 ${ui.assignButtons}/${nChars}`)
  chk(ui.libRows === CANDS.length, `方案库 ${ui.libRows}/${CANDS.length} 行`)
  chk(ui.libButtons === CANDS.length, `方案库试听按钮 ${ui.libButtons}/${CANDS.length}`)
  chk(ui.playAll, `「依次播放全部 ${nChars} 个」按钮存在`)
  chk(ui.canvas > 1000, `首屏波形已绘制（${ui.canvas} 个不透明像素）`)
}

console.log(`\n结果: ${pass} passed, ${fail} failed\n`)
ws.close(); child.kill(); process.exit(fail === 0 ? 0 : 1)
