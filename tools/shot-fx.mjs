/**
 * 对预览页做实时截图验证（CDP）。
 * 用法: node tools/shot-fx.mjs [角色id] [输出目录]
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
const id = process.argv[2] ?? 'claude'
const outDir = process.argv[3] ?? join(process.env.TEMP, 'fx-shots')
mkdirSync(outDir, { recursive: true })

const W = 1280, H = 800
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=9340',
  `--user-data-dir=${join(process.env.TEMP, 'cdp-fx')}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' })

let list = null
for (let i = 0; i < 60; i++) {
  try {
    list = await (await fetch('http://127.0.0.1:9340/json/list')).json()
    if (list && list.length) break
  } catch {}
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

const errors = []
await send('Runtime.enable')
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  }
})

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://127.0.0.1:5199/' })
await sleep(1200)

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, `${id}-${name}.png`), Buffer.from(r.data, 'base64'))
  console.log('  shot', name)
}

// 按**绝对时间轴**采样：每次 captureScreenshot 本身要几百毫秒，
// 累加 sleep 会让后面的采样点漂到动画结束之后。
// 节奏：LEAD=380 DRAW=3400 → 画完 3780ms；语音 640ms 起声；
// 总时长 = max(640+语音+1300, 5080)，淡出占最后 800ms。
// 下面按 chatgpt（总 5140ms）取的采样点。
await shot('00-idle')
const t0 = Date.now()
await send('Runtime.evaluate', { expression: `document.querySelector('button[data-id="${id}"]').click()` })
/** 等到距点击 `ms` 毫秒时截一帧。 */
const at = async (ms, name) => {
  const wait = ms - (Date.now() - t0)
  if (wait > 0) await sleep(wait)
  await shot(name)
}
await at(900, '01-draw-early')    // 描边早期（语音刚起）
await at(2000, '02-draw-mid')     // 描边中期
await at(3400, '03-draw-late')    // 接近画完
await at(4500, '04-name-in')      // 实心 + 公司名正在浮现
await at(5300, '05-name-hold')    // 公司名完整可见（保持段）
await at(6100, '06-fading')       // 淡出中
await at(7000, '07-after')        // 已收起

console.log('ERRORS:', errors.length ? errors.join(' | ') : 'none')
ws.close(); child.kill(); process.exit(0)
