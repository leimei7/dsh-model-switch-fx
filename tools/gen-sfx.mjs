/**
 * 从 tools/sfx-lab.html 抽取定稿的启动音数据，注入 lib/client.js 的 SFX 区块。
 *
 * 为什么要有这一步：试听页是**单一事实来源**（改了候选/分配/增益都在那边调），
 * 插件里只保留播放必需的字段（duty / voices），不搬 UI 文案和差异度用的 shape。
 *
 * 用法: node tools/gen-sfx.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LAB = join(ROOT, 'tools', 'sfx-lab.html')
const CLIENT = join(ROOT, 'lib', 'client.js')

/**
 * 取出 `const <name> = <字面量>` 里那段字面量源码。
 * 用括号配对扫描而不是正则 —— 候选表是嵌套的数组套对象，正则切不干净。
 */
function sliceLiteral(src, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*`).exec(src)
  if (m === null) throw new Error(`在 sfx-lab.html 里找不到 const ${name}`)
  const start = m.index + m[0].length
  const open = src[start]
  if (open !== '[' && open !== '{') throw new Error(`${name} 不是数组或对象字面量`)
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inStr = null
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (inStr !== null) {
      if (ch === '\\') i++
      else if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 的字面量没有闭合`)
}

const html = readFileSync(LAB, 'utf8')
const sandbox = {}
for (const name of ['CANDIDATES', 'ASSIGN', 'GAIN', 'CHARS']) {
  runInNewContext(`out = ${sliceLiteral(html, name)}`, sandbox)
  sandbox[name] = sandbox.out
}
const { CANDIDATES, ASSIGN, GAIN, CHARS } = sandbox

// 只保留播放必需的字段
const plans = {}
for (const c of CANDIDATES) {
  plans[c.id] = {
    name: c.name,
    duty: c.duty,
    voices: c.voices.map((v) => ({ kind: v.kind, events: v.events })),
  }
}

const indent = (text, pad) => text.split('\n').map((l) => pad + l).join('\n')
const block = [
  '/* SFX-BEGIN —— 由 tools/gen-sfx.mjs 从 tools/sfx-lab.html 生成，不要手改 */',
  '/**',
  ' * 每个角色的启动音方案。事件表：[半音偏移, 起始ms, 时长ms]，',
  ' * 有第 4 个元素则是滑音终点（连续 portamento）。',
  ' * 用 Web Audio 实时合成，**不需要任何音频文件**。',
  ' */',
  `var SFX_PLANS = ${indent(JSON.stringify(plans, null, 2), '')}`,
  '',
  '/** 角色 id → 方案 id（11 个角色各一个，互不相同）。 */',
  `var SFX_ASSIGN = ${JSON.stringify(ASSIGN)}`,
  '',
  '/** 每个方案的电平归一化增益（由试听页的 verify-sfx 实测反推）。 */',
  `var SFX_GAIN = ${JSON.stringify(GAIN)}`,
  '',
  '/** 角色声线基频实测值，用来把启动音调到它自己的调上。 */',
  `var SFX_F0 = ${JSON.stringify(CHARS)}`,
  '/* SFX-END */',
].join('\n')

let client = readFileSync(CLIENT, 'utf8')
const begin = client.indexOf('/* SFX-BEGIN')
const end = client.indexOf('/* SFX-END */')
if (begin < 0 || end < 0) throw new Error('lib/client.js 里没有 SFX-BEGIN/END 标记')
client = client.slice(0, begin) + block + client.slice(end + '/* SFX-END */'.length)
writeFileSync(CLIENT, client, 'utf8')

const used = new Set(Object.values(ASSIGN))
console.log(`注入 ${Object.keys(plans).length} 个方案，分配 ${Object.keys(ASSIGN).length} 个角色`)
console.log(`  未分配: ${Object.keys(plans).filter((id) => !used.has(id)).join('、') || '无'}`)
for (const [id, plan] of Object.entries(plans)) {
  const evs = plan.voices.flatMap((v) => v.events)
  const total = Math.max(...evs.map((e) => e[1] + e[2]))
  const glide = evs.some((e) => e.length > 3) ? ' +滑音' : ''
  const marks = [...used].includes(id) ? ' ' : '*'
  console.log(`  ${marks} ${id.padEnd(9)} ${plan.name.padEnd(9)} ${total}ms  `
    + `${plan.voices.length}声部${glide}  duty ${plan.duty}  gain ${GAIN[id]}`)
}
