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

ws.close(); child.kill(); process.exit(0)
