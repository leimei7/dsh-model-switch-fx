/**
 * 验证颗粒层是否真的渲染：截两张图（开颗粒 / 关颗粒），
 * 对比同一块平坦区域的像素标准差。颗粒是随机噪声 → 开的时候标准差应显著更大。
 *
 * 用法: node tools/verify-grain.mjs
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const CHROME = process.env.DSH_FX_CHROME ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=9344',
  `--user-data-dir=${join(process.env.TEMP, 'cdp-grain')}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' })

let list = null
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch('http://127.0.0.1:9344/json/list')).json(); if (list?.length) break } catch {}
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

// 触发一次动画并等浮层完全显现（保持段）
await send('Runtime.evaluate', { expression: `document.querySelector('button[data-id="qwen"]').click()` })
await sleep(5200)

const shot = async () => (await send('Page.captureScreenshot', { format: 'png' })).data

/** 把截图交给页面解码，算指定区域的标准差。 */
const stddevOf = async (base64, x, y, w, h) => {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => {
      const img = new Image()
      img.src = 'data:image/png;base64,${base64}'
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width; c.height = img.height
      const g = c.getContext('2d')
      g.drawImage(img, 0, 0)
      const d = g.getImageData(${x}, ${y}, ${w}, ${h}).data
      let s = 0, s2 = 0, n = 0
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] + d[i+1] + d[i+2]) / 3
        s += v; s2 += v * v; n++
      }
      const mean = s / n
      return JSON.stringify({ mean: +mean.toFixed(3), std: +Math.sqrt(s2 / n - mean * mean).toFixed(3), n })
    })()`,
    awaitPromise: true, returnByValue: true,
  })
  return JSON.parse(r.result.value)
}

const REGION = [980, 380, 220, 220]   // 右侧平坦区，避开 logo / 模拟 UI / 按钮

const withGrain = await shot()
const a = await stddevOf(withGrain, ...REGION)

// 关掉颗粒层
await send('Runtime.evaluate', {
  expression: `(() => { const s = document.createElement('style')
    s.textContent = '#dsf-dim::after{display:none!important}'
    document.head.appendChild(s) })()`,
})
await sleep(300)
const withoutGrain = await shot()
const b = await stddevOf(withoutGrain, ...REGION)

console.log(`区域 ${REGION.join(',')}（宽 ${REGION[2]}px）`)
console.log(`  开颗粒: 均值 ${a.mean}  标准差 ${a.std}`)
console.log(`  关颗粒: 均值 ${b.mean}  标准差 ${b.std}`)
const ratio = b.std > 0 ? (a.std / b.std) : Infinity
console.log(`  标准差比值: ${ratio.toFixed(2)}x`)
console.log('\n判定:')
console.log(' ', a.std > b.std * 1.5 && a.std - b.std > 0.5
  ? `✓ 颗粒确实在渲染（噪声让标准差从 ${b.std} 升到 ${a.std}）`
  : '✗ 看不出颗粒效果 —— 检查 grain.png 是否加载成功')
console.log(' ', Math.abs(a.mean - b.mean) < 2.5
  ? `✓ 亮度只变化 ${(a.mean - b.mean).toFixed(2)}（是"质感"而不是"变亮"）`
  : `注意: 亮度变化 ${(a.mean - b.mean).toFixed(2)}，偏大 —— 调低 #dsf-dim::after 的 opacity`)

ws.close(); child.kill(); process.exit(0)
