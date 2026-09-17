/**
 * 从 showcase.html 解析出每个角色的真实 SVG 路径数据，
 * 注入 lib/client.js 的 LOGOS 区块。
 *
 * 为什么要有这一步：Claude / DeepSeek / GLM 的路径各有一两千字符，
 * 手抄必然出错。showcase.html 是「单一事实来源」，改完它重新生成即可。
 *
 * 用法: node tools/gen-logos.mjs [showcase.html 路径]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = resolve(process.argv[2] ?? join(PACKAGE_ROOT, 'showcase.html'))
const CLIENT = join(PACKAGE_ROOT, 'lib', 'client.js')

/** index.html 里的标题 → 角色 id（资产与语音按 id 命名）。 */
const TITLE_TO_ID = {
  OPENAI: 'chatgpt',
  GEMINI: 'gemini',
  CLAUDE: 'claude',
  KIMI: 'kimi',
  DEEPSEEK: 'deepseek',
  GLM: 'glm',
  QWEN: 'qwen',
  GROK: 'grok',
  MINIMAX: 'minimax',
  MUSESPARK: 'musespark',
  MIMO: 'mimo',
  DOUBAO: 'doubao',
}

const html = readFileSync(SOURCE, 'utf8')

/** 取属性值；找不到返回 undefined。 */
function attr(source, name) {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(source)
  return m === null ? undefined : m[1]
}

// 每个 page 块的顺序即角色顺序。
// 按 page 起始位置切片而不是靠结尾注释 —— 最后一个 page 后面没有分隔注释。
const starts = [...html.matchAll(/<div class="page[^"]*"[^>]*>/g)].map(m => m.index)
const blocks = starts.map((start, index) => html.slice(
  start,
  index + 1 < starts.length ? starts[index + 1] : html.length,
))
const expected = Object.keys(TITLE_TO_ID).length
if (blocks.length !== expected) {
  throw new Error(`expected ${expected} page blocks in ${SOURCE}, found ${blocks.length}`)
}

const logos = []
for (const block of blocks) {
  const titleMatch = /<div class="t"[^>]*>([A-Z]+)<\/div>/.exec(block)
  const title = titleMatch === null ? undefined : titleMatch[1]
  const id = TITLE_TO_ID[title]
  if (id === undefined) throw new Error(`unknown logo title: ${String(title)}`)

  const svgMatch = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/.exec(block)
  if (svgMatch === null) throw new Error(`no <svg> for ${title}`)
  const svgAttrs = svgMatch[1]
  const svgInner = svgMatch[2]

  const viewBox = attr(svgAttrs, 'viewBox')
  if (viewBox === undefined) throw new Error(`no viewBox for ${title}`)

  // 颜色取自 <svg style="--gc:#xxxxxx">
  const gcMatch = /--gc\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(svgAttrs)
  if (gcMatch === null) throw new Error(`no --gc color for ${title}`)
  const color = gcMatch[1]

  // 组上的 stroke-width 是兜底（OpenAI 写在这里）
  const groupMatch = /<g\b([^>]*)>/.exec(svgInner)
  const groupSw = groupMatch === null ? undefined : attr(groupMatch[1], 'stroke-width')

  const raw = [...svgInner.matchAll(/<path\b([^>]*?)\/?>/g)].map(m => {
    const a = m[1]
    const d = attr(a, 'd')
    if (d === undefined) throw new Error(`path without d for ${title}`)
    const tf = attr(a, 'transform')
    const rotMatch = tf === undefined ? null : /rotate\(\s*(-?[\d.]+)/.exec(tf)
    return {
      d,
      rotate: rotMatch === null ? 0 : Number(rotMatch[1]),
      width: Number(attr(a, 'stroke-width') ?? groupSw ?? '1'),
      rule: attr(a, 'fill-rule'),
    }
  })
  if (raw.length === 0) throw new Error(`no paths for ${title}`)

  const strokeWidth = raw[0].width

  // 同一条 d 反复旋转出来的（OpenAI 六瓣）折叠成一个带 copies 的形状
  const paths = []
  const sameD = raw.every(p => p.d === raw[0].d)
  const steps = raw.map(p => p.rotate)
  const step = raw.length > 1 ? steps[1] - steps[0] : 0
  const isRotationRing = sameD && raw.length > 1 && step !== 0
    && steps.every((value, index) => Math.abs(value - index * step) < 1e-6)

  if (isRotationRing) {
    const shape = { d: raw[0].d, copies: raw.length, rotate: step }
    if (raw[0].rule !== undefined) shape.rule = raw[0].rule
    paths.push(shape)
  } else {
    for (const p of raw) {
      const shape = { d: p.d }
      if (p.rule !== undefined) shape.rule = p.rule
      paths.push(shape)
    }
  }

  // 四周留 6% 边距，图形不贴到滤镜边缘
  const [vx, vy, vw, vh] = viewBox.trim().split(/[\s,]+/).map(Number)
  const pad = 0.06 * Math.max(vw, vh)
  const padded = [vx - pad, vy - pad, vw + pad * 2, vh + pad * 2]
    .map(n => Math.round(n * 1000) / 1000)
    .join(' ')

  logos.push({
    id,
    title,
    color,
    viewBox: padded,
    strokeWidth,
    paths,
  })
}

const payload = JSON.stringify(logos, null, 2)
  .split('\n')
  .map((line, index) => (index === 0 ? line : `  ${line}`))
  .join('\n')

const client = readFileSync(CLIENT, 'utf8')
const BEGIN = '/* LOGOS-BEGIN */'
const END = '/* LOGOS-END */'
const from = client.indexOf(BEGIN)
const to = client.indexOf(END)
if (from === -1 || to === -1) throw new Error(`markers not found in ${CLIENT}`)

const next = `${client.slice(0, from + BEGIN.length)}\n  var LOGOS = ${payload}\n  ${client.slice(to)}`
writeFileSync(CLIENT, next)

console.log(`injected ${logos.length} logos into lib/client.js`)
for (const logo of logos) {
  const count = logo.paths.reduce((sum, s) => sum + (s.copies ?? 1), 0)
  const bytes = logo.paths.reduce((sum, s) => sum + s.d.length, 0)
  console.log(`  ${logo.id.padEnd(9)} ${logo.color}  ${String(count).padStart(2)} paths  ${String(bytes).padStart(6)} chars of d  viewBox="${logo.viewBox}"`)
}
