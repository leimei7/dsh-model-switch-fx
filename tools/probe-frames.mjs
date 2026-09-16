/**
 * 逐帧状态探针：在页面里用 rAF 记录每一帧的可见性状态，
 * 用来定位「动画开始前闪一帧完整画面」这类只在单帧里出现的问题。
 *
 * 用法: node tools/probe-frames.mjs [角色id] [采样帧数]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** Chrome 可执行文件；跨平台，可用 DSH_FX_CHROME 环境变量覆盖。 */
const CHROME = process.env.DSH_FX_CHROME ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome')
const id = process.argv[2] ?? 'chatgpt'
const frames = Number(process.argv[3] ?? 24)
/** 第 4 个参数为 takeover 时：先完整播一次，再探测第二次（接管路径风险最高）。 */
const mode = process.argv[4] ?? 'first'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=9343',
  `--user-data-dir=${join(process.env.TEMP, 'cdp-probe')}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' })

let list = null
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:9343/json/list')).json(); if (list && list.length) break } catch {}
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

// 安装 rAF 采样器
await send('Runtime.evaluate', {
  expression: `(function(){
    window.__frames = []
    var n = 0
    window.__startProbe = function (maxFrames) {
      window.__frames = []
      n = 0
      var tick = function () {
        var root = document.querySelector('#dsf-root')
        var stage = document.querySelector('#dsf-stage')
        var outline = document.querySelector('#dsf-stage .dsf-outline path')
        var solid = document.querySelector('#dsf-stage .dsf-solid')
        var company = document.querySelector('#dsf-company')
        var core = document.querySelector('#dsf-core')
        var coreRect = core ? core.getBoundingClientRect() : null
        window.__frames.push({
          f: n,
          t: Math.round(performance.now()),
          rootOp: root ? Number(getComputedStyle(root).opacity).toFixed(3) : null,
          cls: root ? root.className : null,
          svg: stage ? stage.querySelectorAll('svg').length : 0,
          paths: stage ? stage.querySelectorAll('.dsf-outline path').length : 0,
          outOp: outline ? Number(getComputedStyle(outline).opacity).toFixed(3) : null,
          outDash: outline ? getComputedStyle(outline).strokeDashoffset : null,
          solidOp: solid ? Number(getComputedStyle(solid).opacity).toFixed(3) : null,
          compOp: company ? Number(getComputedStyle(company).opacity).toFixed(3) : null,
          coreMidY: coreRect ? Math.round(coreRect.top + coreRect.height / 2) : null
        })
        n++
        if (n < maxFrames) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }
  })()`,
})

// takeover 模式：先完整播一次（含名字保持 + 淡出），再探测第二次。
// 第二次是风险最高的路径 —— 上一次的完成态（dsf-drawn / 实心层）可能残留。
if (mode === 'takeover') {
  await send('Runtime.evaluate', { expression: `document.querySelector('button[data-id="kimi"]').click()` })
  console.log('（takeover 模式：先播完一次 kimi，再探测下一次）')
  await sleep(7200)
}

await send('Runtime.evaluate', { expression: `window.__startProbe(${frames})` })
await send('Runtime.evaluate', { expression: `document.querySelector('button[data-id="${id}"]').click()` })
await sleep(frames * 20 + 900)

const out = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__frames)', returnByValue: true })
const rows = JSON.parse(out.result.value)

console.log(`\n前 ${rows.length} 帧（角色 ${id}，模式 ${mode}）\n`)
console.log('帧   时间    rootOp  class                    svg paths outOp  dash      solidOp compOp coreMidY')
for (const r of rows) {
  console.log(
    String(r.f).padStart(3),
    String(r.t).padStart(7),
    String(r.rootOp).padStart(7),
    '  ' + String(r.cls).padEnd(24),
    String(r.svg).padStart(3),
    String(r.paths).padStart(5),
    String(r.outOp).padStart(6),
    String(r.outDash).padStart(9),
    String(r.solidOp).padStart(7),
    String(r.compOp).padStart(6),
    String(r.coreMidY).padStart(9),
  )
}

// 判定：
//  1) 任何一帧都不该出现「描边已画满」或「实心层已可见」而浮层可见的情况
//  2) 浮层首次可见的那一帧，描边必须还是隐藏的
console.log('\n判定：')
const visible = rows.filter((r) => r.cls && r.cls.indexOf('dsf-on') !== -1)
const firstVisible = visible[0]
let spoilers = 0
for (const r of rows) {
  if (!r.cls || r.cls.indexOf('dsf-on') === -1) continue
  if (r.outDash === '0px' || r.solidOp === '1.000') spoilers++
}
if (!firstVisible) console.log('  ? 没采到浮层可见的帧')
else {
  console.log(`  浮层首次可见：第 ${firstVisible.f} 帧  outOp=${firstVisible.outOp} dash=${firstVisible.outDash} solidOp=${firstVisible.solidOp}`)
  console.log('  ',
    firstVisible.outOp === '0.000' && firstVisible.outDash === '1000px' && firstVisible.solidOp === '0.000'
      ? '✓ 首帧已完全隐藏（无剧透）'
      : '✗ 首帧有剧透')
  console.log('  ', spoilers === 0 ? '✓ 可见帧里没有出现过完整画面' : `✗ 有 ${spoilers} 帧出现完整画面`)
}
if (firstVisible && firstVisible.coreMidY !== null) {
  console.log(`  内容垂直中心 coreMidY=${firstVisible.coreMidY}（视口中心 400，越小越靠上）`)
}

ws.close(); child.kill(); process.exit(0)
