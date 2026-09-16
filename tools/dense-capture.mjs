/**
 * 密集抓帧：每 250ms 一帧，横跨整段描边，用来找动画瑕疵/掉帧。
 * 用法: node tools/dense-capture.mjs <角色id> [间隔ms]
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
const id = process.argv[2] ?? 'chatgpt'
const step = Number(process.argv[3] ?? 250)
const outDir = join(process.env.TEMP, 'fx-dense')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=9342',
  `--user-data-dir=${join(process.env.TEMP, 'cdp-dense')}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' })

let list = null
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:9342/json/list')).json(); if (list && list.length) break } catch {}
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

// 采集每帧的绘制进度，用于判断是否卡顿
await send('Runtime.evaluate', {
  expression: `(function(){
    window.__probe = []
    var orig = Element.prototype.animate
    Element.prototype.animate = function () {
      var a = orig.apply(this, arguments)
      try { window.__probe.push({ t: performance.now(), tracked: true }) } catch (e) {}
      return a
    }
  })()`,
})

const t0 = Date.now()
await send('Runtime.evaluate', { expression: `document.querySelector('button[data-id="${id}"]').click()` })

const frames = []
let i = 0
while (Date.now() - t0 < 4200) {
  const target = t0 + i * step
  const wait = target - Date.now()
  if (wait > 0) await sleep(wait)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const name = `${id}-t${String(i * step).padStart(4, '0')}`
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'))
  frames.push(name)
  i++
}
console.log(`captured ${frames.length} frames into ${outDir}`)
ws.close(); child.kill(); process.exit(0)
