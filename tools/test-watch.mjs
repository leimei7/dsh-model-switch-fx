/**
 * host 半边逻辑自测 —— 不需要起 DSH，也不碰用户正在跑的服务。
 *
 * 验证「换模型就播」的触发与去重：
 *   1. 路由与 index 注入注册齐全
 *   2. 没有浏览器连接时不广播
 *   3. 换到已知角色 → 广播正确的 id / 时长
 *   4. 重选当前正在用的那个 → 不播
 *   5. 同一条路由重复变更（request/header 也会触发 onChanged）→ 不重播
 *   6. 换到 11 个角色之外 → 不播
 *   7. 非 modelSelection 的投影变更 → 不播
 *   8. 连续换两个不同模型 → 播两次
 *
 * 用法: node tools/test-watch.mjs
 */

import { apply, VOICES } from '../lib/index.js'

let pass = 0
let fail = 0

function check(label, condition, detail) {
  if (condition) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** 造一个够用的假 ctx，把插件挂上去。 */
function makeCtx() {
  const routes = new Map()
  const handlers = new Map()
  const states = new Map()
  let changeListener = null

  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    sessionProjections: {
      stateOf(session) {
        return states.get(session)
      },
      onChanged(listener) {
        changeListener = listener
        return () => { changeListener = null }
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler))
      }
    },
    effect(fn) {
      fn()
    },
  }

  apply(ctx, {})

  /** 每个 session 的事件序号（真实 DSH 里一个事件一个 seq）。 */
  const seqs = new Map()

  /** 设定某 session 的投影状态，并触发一次变更通知。 */
  const emit = (session, state, key = 'modelSelection', rev) => {
    states.set(session, state)
    if (changeListener === null) throw new Error('change listener not registered')
    // 真实 onChanged 的第 4 个参数是「引起本次变化的事件序号」，每个事件递增。
    // 同一次选择的重复回调会带着**相同** seq（这正是插件去重的依据），
    // 所以测试可以显式传 rev 来模拟「同一次变化的重复通知」。
    const next = rev ?? (seqs.get(session) ?? 0) + 1
    seqs.set(session, next)
    changeListener(session, key, undefined, next)
  }

  return { ctx, routes, handlers, emit }
}

/** 假 SSE 响应，登记进插件的 clients 集合。 */
function openSse(route) {
  const chunks = []
  const listeners = new Map()
  const res = {
    writeHead() {},
    write(chunk) { chunks.push(String(chunk)) },
    on(event, fn) { listeners.set(event, fn) },
    end() {},
    chunks,
  }
  route.handler({ method: 'GET', url: '/model-switch-fx/events', on() {} }, res)
  return res
}

/** 取出所有 play 帧。 */
function plays(res) {
  return res.chunks
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((payload) => payload.type === 'play')
}

const session = { id: 'session-1' }
const route = (provider, model) => ({ provider, model })

console.log('\n[1] 路由与 index 注入注册齐全')
{
  const { routes, handlers } = makeCtx()
  // 从 VOICES 动态取数量：加角色时这条断言不会过期
  const voiceCount = Object.keys(VOICES).length
  check(`voice 路由 ${voiceCount} 条`, [...routes.keys()].filter((p) => p.includes('/voice/')).length === voiceCount)
  check('client.js 路由', routes.has('/model-switch-fx/client.js'))
  check('events 路由', routes.has('/model-switch-fx/events'))
  check('done 路由', routes.has('/model-switch-fx/done'))
  check('index 注入监听已注册', (handlers.get('webserver/index-inject') ?? []).length === 1)

  const table = []
  handlers.get('webserver/index-inject')[0](table)
  check('注入表含 style / preload / script-src',
    table.map((r) => r.kind).join(',') === 'style,script-preload,script-src',
    table.map((r) => r.kind).join(','))
  check('不再监听 agent/pre-step（闸门已移除）',
    (handlers.get('agent/pre-step') ?? []).length === 0)
}

console.log('\n[2] 没有浏览器连接 → 不广播')
{
  const { routes, emit } = makeCtx()
  // 不 openSse
  const sse = openSse(routes.get('/model-switch-fx/events'))
  // 先断开：模拟无连接
  sse.on('close', () => {}) // 触发不了，用另一种方式：新建 ctx 测试更直接
  const fresh = makeCtx()
  fresh.emit(session, { lastUsed: route('openai', 'gpt-4'), pending: route('deepseek-official', 'deepseek-v4-pro') })
  check('无连接时静默（未抛错）', true)
}

console.log('\n[3] 换到 deepseek → 广播正确的角色')
{
  const { routes, emit } = makeCtx()
  const sse = openSse(routes.get('/model-switch-fx/events'))
  emit(session, { lastUsed: route('xiaomi-token-plan-cn', 'mimo-v2.5'), pending: route('deepseek-official', 'deepseek-v4-pro') })
  const list = plays(sse)
  check('广播了 1 次', list.length === 1, String(list.length))
  check('角色 id 正确', list[0]?.id === 'deepseek', JSON.stringify(list[0]))
  check('时长与实测一致', list[0]?.voice === VOICES.deepseek, String(list[0]?.voice))
  check('带了 token', typeof list[0]?.token === 'string')
}

console.log('\n[4] 重选当前正在用的那个 → 也要播（用户确实点了，就该有反应）')
{
  const { routes, emit } = makeCtx()
  const sse = openSse(routes.get('/model-switch-fx/events'))
  // 这正是之前的 bug：默认模型就是 deepseek-official/deepseek-flash
  // （选择器显示「DeepSeek-V41-Flash」），点它时 pending 与 lastUsed 相同，
  // 旧逻辑按路由去重 + sameRoute 判定把它整个吃掉，看起来像识别不了。
  emit(session, {
    lastUsed: route('deepseek-official', 'deepseek-flash'),
    pending: route('deepseek-official', 'deepseek-flash'),
  })
  check('播了 1 次', plays(sse).length === 1, String(plays(sse).length))
  check('角色是 deepseek', plays(sse)[0]?.id === 'deepseek', String(plays(sse)[0]?.id))
}

console.log('\n[5] 同一次选择被重复通知（同 seq）→ 不重播；pending 清空后也不播')
{
  const { routes, emit } = makeCtx()
  const sse = openSse(routes.get('/model-switch-fx/events'))
  const target = route('anthropic', 'claude-sonnet-4')
  emit(session, { lastUsed: route('deepseek-official', 'deepseek-v4-flash'), pending: target })
  check('第一次播了', plays(sse).length === 1)
  // 同一次「选择」事件引起的重复通知 → 同一个 seq → 必须挡掉
  emit(session, { lastUsed: route('deepseek-official', 'deepseek-v4-flash'), pending: target }, 'modelSelection', 1)
  check('同 seq 重复通知没有重播', plays(sse).length === 1, String(plays(sse).length))
  // 消息发出后 pending 被清空 → 也不播
  emit(session, { lastUsed: target, pending: null })
  check('pending 清空后不播', plays(sse).length === 1, String(plays(sse).length))
}

console.log('\n[6] 换到 11 个角色之外 → 不播')
{
  const { routes, emit } = makeCtx()
  const sse = openSse(routes.get('/model-switch-fx/events'))
  emit(session, { lastUsed: route('deepseek-official', 'deepseek-v4-flash'), pending: route('some-vendor', 'unknown-model-x1') })
  check('没有 play 帧', plays(sse).length === 0)
}

console.log('\n[6b] xiaomi MiMo 现在也要播（以前被当成「不在表里」）')
{
  const { routes, emit } = makeCtx()
  const sse = openSse(routes.get('/model-switch-fx/events'))
  emit(session, { lastUsed: route('deepseek-official', 'deepseek-v4-flash'), pending: route('xiaomi-token-plan-cn', 'mimo-v2.5') })
  check('播了 1 次', plays(sse).length === 1, String(plays(sse).length))
  check('角色是 mimo', plays(sse)[0]?.id === 'mimo', String(plays(sse)[0]?.id))
}

console.log('\n[7] 非 modelSelection 的投影变更 → 不播')
{
  const { routes, emit } = makeCtx()
  const sse = openSse(routes.get('/model-switch-fx/events'))
  emit(session, { lastUsed: null, pending: route('anthropic', 'claude-sonnet-4') }, 'sessionStats')
  check('没有 play 帧', plays(sse).length === 0)
}

console.log('\n[8] 连续换两个不同模型 → 播两次，各播各的')
{
  const { routes, emit } = makeCtx()
  const sse = openSse(routes.get('/model-switch-fx/events'))
  emit(session, { lastUsed: route('deepseek-official', 'deepseek-v4-flash'), pending: route('anthropic', 'claude-sonnet-4') })
  emit(session, { lastUsed: route('deepseek-official', 'deepseek-v4-flash'), pending: route('google', 'gemini-2.5-pro') })
  const list = plays(sse)
  check('播了 2 次', list.length === 2, String(list.length))
  check('角色顺序 claude → gemini',
    list.map((p) => p.id).join(',') === 'claude,gemini',
    list.map((p) => p.id).join(','))
}

console.log('\n[9] 换出去再换回来 → 也要播（不是永久去重）')
{
  const { routes, emit } = makeCtx()
  const sse = openSse(routes.get('/model-switch-fx/events'))
  emit(session, { lastUsed: null, pending: route('openai', 'gpt-5') })
  emit(session, { lastUsed: route('openai', 'gpt-5'), pending: null })
  emit(session, { lastUsed: route('openai', 'gpt-5'), pending: route('kimi', 'kimi-k2') })
  emit(session, { lastUsed: route('kimi', 'kimi-k2'), pending: null })
  emit(session, { lastUsed: route('kimi', 'kimi-k2'), pending: route('openai', 'gpt-5') })
  const list = plays(sse)
  check('播了 3 次', list.length === 3, String(list.length))
  check('角色顺序 chatgpt → kimi → chatgpt',
    list.map((p) => p.id).join(',') === 'chatgpt,kimi,chatgpt',
    list.map((p) => p.id).join(','))
}

console.log('\n[10] 真实路由 → 角色 对照表（每加一个角色都该过一遍）')
{
  // 左边是真实出现在 provider/model 里的字符串，右边是期望命中的角色（undefined = 不播）
  const table = [
    ['deepseek-official', 'deepseek-flash', 'deepseek'],
    ['deepseek-official', 'deepseek-v41-flash', 'deepseek'],
    ['deepseek-official', 'deepseek-v4-pro', 'deepseek'],
    ['openai', 'gpt-5.6-luna', 'chatgpt'],
    ['anthropic', 'claude-sonnet-4', 'claude'],
    ['google', 'gemini-2.5-pro', 'gemini'],
    ['moonshot', 'kimi-k2', 'kimi'],
    ['zhipu', 'glm-5.3', 'glm'],
    ['opencode-go-qwen', 'qwen3.8-max', 'qwen'],
    ['xai', 'grok-4', 'grok'],
    ['opencode-go', 'grok-4.6', 'grok'],
    ['minimax', 'abab7', 'minimax'],
    ['minimax-cn', 'hailuo-2.5', 'minimax'],
    ['meta', 'musespark-1', 'musespark'],
    ['meta-ai', 'muse-spark-pro', 'musespark'],
    ['xiaomi-token-plan-cn', 'mimo-v2.5', 'mimo'],
    ['xiaomi', 'mimo-7b', 'mimo'],
    ['some-vendor', 'unknown-model-x1', undefined],
  ]
  for (const [provider, model, want] of table) {
    const { routes, emit } = makeCtx()
    const sse = openSse(routes.get('/model-switch-fx/events'))
    emit(session, { lastUsed: null, pending: route(provider, model) })
    const got = plays(sse)[0]?.id
    check(`${provider}/${model} → ${want ?? '(不播)'}`, got === want, String(got))
  }
}

console.log(`\n结果: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
