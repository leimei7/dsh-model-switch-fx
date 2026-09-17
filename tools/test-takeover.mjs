/**
 * 验证「上一段还在播时又切模型」会不会被接管。
 * 这是之前「只能切一次」的根因：旧实现用 busy 守卫直接 return 丢掉了新的 play。
 *
 * 用法: node tools/test-takeover.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Chrome 可执行文件；跨平台，可用 DSH_FX_CHROME 环境变量覆盖。 */
const CHROME = process.env.DSH_FX_CHROME ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome')
const outDir = join(process.env.TEMP, 'fx-takeover')
mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=9341',
  `--user-data-dir=${join(process.env.TEMP, 'cdp-takeover')}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' })

let list = null
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:9341/json/list')).json(); if (list && list.length) break } catch {}
  await sleep(300)
}
const page = list.find((t) => t.type === 'page')
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

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://127.0.0.1:5199/' })
await sleep(1200)

// 拦截 Web Audio 的节点创建，用来核对启动音实际排布了多少声部。
// 必须在第一次播放之前装好（client.js 是惰性建 AudioContext 的）。
await send('Runtime.evaluate', {
  expression: `(function () {
    window.__sfx = { osc: 0, noise: 0, wave: 0, ctx: 0, order: [] }
    var AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    var p = AC.prototype
    var co = p.createOscillator, cb = p.createBufferSource, cw = p.createPeriodicWave
    p.createOscillator = function () {
      window.__sfx.osc++; window.__sfx.order.push(['osc', Date.now()])
      return co.apply(this, arguments)
    }
    p.createBufferSource = function () {
      window.__sfx.noise++; window.__sfx.order.push(['noise', Date.now()])
      return cb.apply(this, arguments)
    }
    p.createPeriodicWave = function () {
      window.__sfx.wave++
      return cw.apply(this, arguments)
    }
  })()`,
})
const resetSfx = () => send('Runtime.evaluate', {
  expression: `(function(){ window.__sfx.osc=0; window.__sfx.noise=0; window.__sfx.wave=0; window.__sfx.order=[] })()`,
})
const readSfx = async () => JSON.parse((await send('Runtime.evaluate', {
  expression: 'JSON.stringify(window.__sfx)', returnByValue: true,
})).result.value)

/**
 * 轮询等到浮层收起。
 * **不要写死时长** —— 总时长现在是算出来的：语音约束、公司名约束、
 * 以及「启动音起手 + 长度 + 留白」三者取最大。加了启动音之后减少动效模式
 * 的总时长会变（220ms 的固定延迟被 510ms 的启动音后推取代），写死必错。
 */
const waitIdle = async (maxMs = 14000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    if (!(await state()).on) return true
    await sleep(200)
  }
  return false
}

const click = (id) => send('Runtime.evaluate', { expression: `document.querySelector('button[data-id="${id}"]').click()` })
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'))
  console.log('  shot', name)
}
/** 读页面上的诊断信息（client.js 暴露的当前角色）。 */
const state = async () => {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){
      var root = document.querySelector('#dsf-root')
      var outline = document.querySelector('#dsf-stage .dsf-outline')
      var company = document.querySelector('#dsf-company')
      var dim = document.querySelector('#dsf-dim')
      var halo = document.querySelector('#dsf-halo')
      var solid = document.querySelector('#dsf-stage .dsf-solid')
      var core = document.querySelector('#dsf-core')
      var coreRect = core ? core.getBoundingClientRect() : null
      var firstPath = document.querySelector('#dsf-stage .dsf-outline path')
      // 发一个不带修饰键的 keydown，看捕获阶段的拦截是否生效
      var probe = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
      window.dispatchEvent(probe)
      return JSON.stringify({
        stageColor: outline ? outline.getAttribute('stroke') : null,
        on: !!document.querySelector('#dsf-root.dsf-on'),
        svg: !!document.querySelector('#dsf-stage svg'),
        company: company ? company.textContent : null,
        companyOpacity: company ? Number(getComputedStyle(company).opacity) : null,
        // 最终染色（实心层）必须在画完后亮起来 —— 缺了这条断言，
        // 「内联 opacity:0 盖掉 CSS 的 dsf-drawn 规则」这个回归就漏过去了
        solidOpacity: solid ? Number(getComputedStyle(solid).opacity) : null,
        // 描边进度：正常模式从 1000px(未绘制) 走到 0px；减少动效模式一开始就是 0px
        outlineDash: firstPath ? getComputedStyle(firstPath).strokeDashoffset : null,
        outlineOpacity: firstPath ? Number(getComputedStyle(firstPath).opacity) : null,
        // 挂在舞台上的 WAAPI 动画数量：减少动效模式应为 0
        stageAnims: document.querySelector('#dsf-stage svg')
          ? document.querySelector('#dsf-stage svg').getAnimations().length
          : 0,
        pointerEvents: root ? getComputedStyle(root).pointerEvents : null,
        keyBlocked: probe.defaultPrevented,
        // 光晕住在 #dsf-stage 里，不能被 clearSvg 误删
        haloPresent: !!halo,
        haloOpacity: halo ? Number(getComputedStyle(halo).opacity) : null,
        // 内容垂直中心：应明显小于视口中心 400（居上）
        coreMidY: coreRect ? Math.round(coreRect.top + coreRect.height / 2) : null,
        // 背景不做虚化：应为 none
        dimBackdrop: dim
          ? (getComputedStyle(dim).backdropFilter || getComputedStyle(dim).webkitBackdropFilter || 'none')
          : null
      })
    })()`,
    returnByValue: true,
  })
  return JSON.parse(r.result.value)
}

console.log('\n[1] 正常播一段 claude')
// 补丁拦截 play()，记录真实起声时刻 —— 用来验证「不立刻播放声音」
await send('Runtime.evaluate', {
  expression: `(function(){
    window.__playLog = []
    var orig = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      window.__playLog.push(Date.now())
      return orig.apply(this, arguments)
    }
  })()`,
})
const clickedAt = Date.now()
await click('claude')
await sleep(900)
let s = await state()
console.log('   ', JSON.stringify(s))
console.log('  ', s.on && s.svg ? 'ok  正在播（dsf-on）' : 'FAIL 没在播')
{
  const log = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__playLog)', returnByValue: true })
  const times = JSON.parse(log.result.value)
  const delay = times.length > 0 ? times[0] - clickedAt : null
  console.log(`   起声延迟 ${delay}ms（目标 640ms）`)
  console.log('  ', delay !== null && delay >= 560 ? 'ok  不是立刻起声' : `FAIL 起声太早/没起声：${delay}`)
  console.log('  ', delay !== null && delay <= 900 ? 'ok  延迟在合理范围' : `FAIL 延迟过大：${delay}`)
}
await shot('01-claude')

console.log('\n[2] 播放中途切到 deepseek（关键用例）')
await click('deepseek')
await sleep(900)
s = await state()
console.log('   ', JSON.stringify(s))
const isDeepseek = s.stageColor === '#00D4FF'
console.log('  ', isDeepseek ? 'ok  已接管为 deepseek（青色 #00D4FF）' : `FAIL 仍是旧的：${s.stageColor}`)
await shot('02-takeover-deepseek')

console.log('\n[3] 再中途切到 chatgpt（第三次）')
await click('chatgpt')
// 从这里开始按**绝对时间轴**采样：每次 state()/shot() 都要几百毫秒，
// 累加 sleep 会让后面的检查点漂过它本来要验证的窗口。
const t3 = Date.now()
const at = async (ms) => {
  const wait = ms - (Date.now() - t3)
  if (wait > 0) await sleep(wait)
}
await at(900)
s = await state()
console.log('   ', JSON.stringify(s))
const isChatgpt = s.stageColor === '#10b981'
console.log('  ', isChatgpt ? 'ok  已接管为 chatgpt（绿色 #10b981）' : `FAIL 仍是旧的：${s.stageColor}`)
await shot('03-takeover-chatgpt')

console.log('\n[4] 描边期间：输入被接管')
await at(3200)
s = await state()
console.log('   ', JSON.stringify(s))
console.log('  ', s.company === 'OpenAI' ? 'ok  公司名 = OpenAI' : `FAIL 公司名 = ${s.company}`)
console.log('  ', s.pointerEvents === 'auto' ? 'ok  遮罩接管指针（pointer-events:auto）' : `FAIL pointer-events=${s.pointerEvents}`)
console.log('  ', s.keyBlocked ? 'ok  键盘被拦截' : 'FAIL 键盘没拦住')
console.log('  ',
  s.dimBackdrop === 'none'
    ? 'ok  背景无虚化（backdrop-filter: none）'
    : `FAIL 背景仍在虚化：${s.dimBackdrop}`)
await shot('04-active-modal')

console.log('\n[5] 保持段：公司名必须完整可见（回归：以前名字一闪就淡出）')
// chatgpt 总时长 6380ms：名字 3780ms 浮现、600ms 淡入完、5580ms 才开始淡出。
// 取 5100ms —— 落在「已完全可见、还没开始淡出」的窗口里。
await at(5100)
s = await state()
console.log('   ', JSON.stringify(s))
console.log('  ', s.on ? 'ok  仍在播（dsf-on 还在）' : 'FAIL 已经收起了')
console.log('  ',
  s.companyOpacity !== null && s.companyOpacity > 0.9
    ? `ok  公司名完整可见（opacity=${s.companyOpacity}）`
    : `FAIL 名字还没到全不透明就被淡出了：opacity=${s.companyOpacity}`)
console.log('  ',
  s.solidOpacity !== null && s.solidOpacity > 0.9
    ? `ok  最终染色已亮起（实心层 opacity=${s.solidOpacity}）`
    : `FAIL 最终染色没出现：实心层 opacity=${s.solidOpacity}`)
console.log('  ',
  s.haloPresent && s.haloOpacity !== null && s.haloOpacity > 0.1
    ? `ok  光晕存活且在显示（opacity=${s.haloOpacity}）`
    : `FAIL 光晕丢了或被 clearSvg 删了：present=${s.haloPresent} opacity=${s.haloOpacity}`)
console.log('  ',
  s.coreMidY !== null && s.coreMidY < 385 && s.coreMidY > 250
    ? `ok  内容居上（coreMidY=${s.coreMidY} < 400）`
    : `FAIL 没有居上：coreMidY=${s.coreMidY}`)
await shot('05-name-hold')

console.log('\n[6] 等动画自然结束 → 应完全收起并解锁')
await at(7000)
s = await state()
console.log('   ', JSON.stringify(s))
console.log('  ', !s.on ? 'ok  已收起（dsf-on 移除）' : 'FAIL 没收起')
console.log('  ', s.pointerEvents === 'none' ? 'ok  指针已放行' : `FAIL pointer-events=${s.pointerEvents}`)
console.log('  ', !s.keyBlocked ? 'ok  键盘已放行' : 'FAIL 键盘还锁着')
await shot('06-idle-again')

console.log('\n[7] 结束后再切一次 → 仍要能播')
await click('gemini')
await sleep(900)
s = await state()
console.log('   ', JSON.stringify(s))
console.log('  ', s.on && s.stageColor === '#8E75FF' ? 'ok  又播了 gemini' : `FAIL ${JSON.stringify(s)}`)
console.log('  ', s.company === 'Google DeepMind' ? 'ok  公司名 = Google DeepMind' : `FAIL 公司名 = ${s.company}`)

console.log('\n[8] 后加的角色：qwen / grok / minimax / musespark / mimo')
for (const role of [
  { id: 'qwen', color: '#615CED', company: 'Qwen' },
  { id: 'grok', color: '#E8EAED', company: 'SpaceXAI' },
  { id: 'minimax', color: '#F03B5D', company: 'MiniMax Group Inc.' },
  { id: 'musespark', color: '#0081FB', company: 'Meta' },
  { id: 'mimo', color: '#FF6900', company: 'Xiaomi MiMo' },
]) {
  await click(role.id)
  const t = Date.now()
  /** 等到距本次点击 ms 毫秒。 */
  const atRole = async (ms) => {
    const wait = ms - (Date.now() - t)
    if (wait > 0) await sleep(wait)
  }
  await atRole(5100)   // 落在保持段（总时长 6380，淡出从 5580 开始）
  const st = await state()
  console.log(`   ${role.id}:`, JSON.stringify(st))
  console.log('  ',
    st.on && st.stageColor === role.color
      ? `ok  ${role.id} 正在播（${role.color}）`
      : `FAIL ${role.id} stageColor=${st.stageColor}`)
  console.log('  ',
    st.solidOpacity !== null && st.solidOpacity > 0.9
      ? `ok  ${role.id} 最终染色已亮起`
      : `FAIL ${role.id} 没染色：solidOpacity=${st.solidOpacity}`)
  console.log('  ',
    st.company === role.company
      ? `ok  公司名 = ${role.company}`
      : `FAIL 公司名 = ${st.company}`)
  await shot(`08-${role.id}`)
  await atRole(7200)   // 等它收完再切下一个，避免互相接管
}

console.log('\n[9] prefers-reduced-motion: reduce → 不描边，直接给完成态')
{
  // 模拟系统开了「减少动态效果」
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await sleep(200)

  const media = await send('Runtime.evaluate', {
    expression: `window.matchMedia('(prefers-reduced-motion: reduce)').matches`,
    returnByValue: true,
  })
  console.log('  ', media.result.value ? 'ok  媒体查询已生效' : 'FAIL 模拟没生效')

  await click('claude')
  const t = Date.now()
  const atR = async (ms) => { const w = ms - (Date.now() - t); if (w > 0) await sleep(w) }

  // 150ms：正常模式下这时描边还停在 1000px（未绘制），减少动效模式应已是 0px
  await atR(150)
  let r = await state()
  console.log('   ', JSON.stringify(r))
  console.log('  ',
    r.outlineDash === '0px' && r.outlineOpacity === 1
      ? 'ok  一开始就是画满的（没有描边过程）'
      : `FAIL 仍在描边：dash=${r.outlineDash} opacity=${r.outlineOpacity}`)
  console.log('  ',
    r.stageAnims === 0
      ? 'ok  没有布任何 WAAPI 动画'
      : `FAIL 仍有 ${r.stageAnims} 个动画在跑`)
  console.log('  ', r.on ? 'ok  浮层可见' : 'FAIL 浮层没出现')
  console.log('  ',
    r.haloOpacity !== null && r.haloOpacity > 0.1
      ? `ok  光晕仍在显示（opacity=${r.haloOpacity}）`
      : `FAIL 光晕丢了：${r.haloOpacity}`)

  // 保持段：实心染色 + 公司名照样要有（信息不能丢）
  await atR(4200)
  r = await state()
  console.log('   ', JSON.stringify(r))
  console.log('  ',
    r.solidOpacity !== null && r.solidOpacity > 0.9
      ? 'ok  最终染色照样亮起'
      : `FAIL 没染色：${r.solidOpacity}`)
  console.log('  ',
    r.company === 'Anthropic' && r.companyOpacity > 0.9
      ? 'ok  公司名照样完整可见（信息没丢）'
      : `FAIL 公司名=${r.company} opacity=${r.companyOpacity}`)
  await shot('09-reduced-motion')

  // 收尾后要完全恢复（轮询，别写死时长）
  const done = await waitIdle()
  r = await state()
  console.log('  ', done && !r.on && !r.keyBlocked ? 'ok  正常收起并解锁' : `FAIL 没收干净：${JSON.stringify(r)}`)

  // 恢复默认媒体设置，别影响后续
  await send('Emulation.setEmulatedMedia', { features: [] })
}

console.log('\n[10] 启动音：按方案排布声部（拦截 Web Audio 节点创建核对）')
{
  // 每个角色分到哪个方案、该方案有几个脉冲音 / 几路噪声，用插件的 SFX 数据算出来。
  // 客户端是 IIFE，内部变量读不到 —— 走它暴露的只读诊断出口 window.__dsfFx。
  const spec = JSON.parse((await send('Runtime.evaluate', {
    expression: `(function(){
      var d = window.__dsfFx
      if (!d) return 'null'
      var out = {}
      for (var cid in d.assign) {
        var p = d.plans[d.assign[cid]]
        var pulse = 0, noise = 0
        for (var i = 0; i < p.voices.length; i++) {
          if (p.voices[i].kind === 'noise') noise += p.voices[i].events.length
          else pulse += p.voices[i].events.length
        }
        out[cid] = { plan: d.assign[cid], name: p.name, pulse: pulse, noise: noise,
                     f0: d.f0[cid], root: Math.round(d.root(d.f0[cid])),
                     ms: d.durationMs(cid) }
      }
      return JSON.stringify(out)
    })()`, returnByValue: true,
  })).result.value)
  if (spec === null) {
    console.log('  ', 'FAIL window.__dsfFx 不存在 —— 客户端没暴露诊断出口')
  } else {
  console.log('    角色 → 方案 → 应排布的节点数：')
  for (const [cid, s] of Object.entries(spec)) {
    console.log(`      ${cid.padEnd(11)} ${s.name.padEnd(9)} 脉冲×${s.pulse} 噪声×${s.noise}`
      + `  F0 ${s.f0}Hz → 根音 ${s.root}Hz`)
  }
  console.log('  ', Object.keys(spec).length === 11 ? 'ok  11 个角色都有方案与基频' : `FAIL 只有 ${Object.keys(spec).length} 个`)

  // 逐个角色实际播一次，核对节点数
  let mismatch = []
  for (const [cid, s] of Object.entries(spec)) {
    await resetSfx()
    await click(cid)
    await sleep(320)          // 启动音在 60ms 起手，最长 380ms
    const got = await readSfx()
    if (got.osc !== s.pulse || got.noise !== s.noise) {
      mismatch.push(`${cid}: 期望 脉冲${s.pulse}/噪声${s.noise}，实际 脉冲${got.osc}/噪声${got.noise}`)
    }
    console.log(`      ${cid.padEnd(11)} 实际 脉冲×${got.osc} 噪声×${got.noise}`
      + (got.osc === s.pulse && got.noise === s.noise ? '  ✓' : '  ✗'))
    await waitIdle()          // 等它整段收完，避免接管影响下一次统计
  }
  console.log('  ', mismatch.length === 0 ? 'ok  11 个角色的声部排布全部正确' : `FAIL ${mismatch.join(' | ')}`)

  // 启动音必须在语音之前响（顺序核对）
  await resetSfx()
  await click('grok')
  await sleep(320)
  const early = await readSfx()
  console.log('  ', early.osc > 0 || early.noise > 0
    ? `ok  启动音在点击后 320ms 内已排布（脉冲×${early.osc} 噪声×${early.noise}）`
    : 'FAIL 启动音没排布')
  await waitIdle()
  }
}

console.log('\n[11] 启动音开关：sfx=0 时一个节点都不排')
{
  await click('claude')
  await waitIdle()
  await resetSfx()
  // 通过 preview 的 trigger 通道把 sfx=0 传进去
  await send('Runtime.evaluate', {
    expression: `fetch('/trigger?id=claude&sfx=0')`,
  })
  await sleep(400)
  const off = await readSfx()
  console.log('   ', off.osc === 0 && off.noise === 0
    ? 'ok  sfx=0 时没有排布任何音频节点'
    : `FAIL 仍然排布了 脉冲${off.osc}/噪声${off.noise}`)
  // 动画本身照常要播（关的只是音效）
  const st = await state()
  console.log('   ', st.on ? 'ok  动画不受影响，照常播放' : 'FAIL 动画没播')
  await waitIdle()
}

ws.close(); child.kill(); process.exit(0)
