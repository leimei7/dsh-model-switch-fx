/**
 * dsh-model-switch-fx — host half.
 *
 * 切模型时在屏幕中央播放对应 AI 娘的 logo 描边动画 + 角色语音。
 *
 * 触发点：模型选择的**当下**，不是发消息的时候。
 *   用户在 composer 的模型座位上选了另一个模型 → 客户端调用 `session.selectModel`
 *   → 宿主 `agent.session.append('model/selection', selection)`
 *   （见 packages/core/agent/src/agent.ts）
 *   → `modelSelection` 投影的 `pending` 更新
 *   → 本插件在 `sessionProjections.onChanged` 里收到通知，立刻广播播放指令。
 *
 * 因为触发时还没有任何 LLM 请求，所以这里**不拦截、不阻塞**任何流程，
 * 纯粹是一个即时的视觉/听觉反馈。
 *
 * 去重：`onChanged` 在 `request/header` 事件上也会触发（视图里的 lastUsed 变了），
 * 所以必须按「上一次播过的路由」去重，否则每次发消息都会重播一遍。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-model-switch-fx'

/** `webServer` 提供路由与 index 注入；`sessionProjections` 是模型选择的观测点。 */
export const inject = ['webServer', 'sessionProjections']

/** 包根目录（lib/index.js → 上一级）。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 本插件占用的 URL 前缀。 */
const BASE = '/model-switch-fx'

/**
 * 每个角色的语音时长（秒），与 assets/*.mp3 实测一致。
 * 浏览器用它算动画总时长：总时长 = 语音时长 + 淡出。
 */
export const VOICES = {
  grok: 4.42,
  chatgpt: 3.2,
  kimi: 3.36,
  qwen: 3.36,
  musespark: 3.36,
  gemini: 3.52,
  glm: 3.84,
  deepseek: 4.16,
  claude: 4.48,
  mimo: 4.48,
  minimax: 5.44,
  // 唯一的中文角色（台词「你好，完全没问题！豆包已连接」），实测 3.29s
  // （原录音 3.00s 是硬切的，补了混响尾巴 + 淡出后变成 3.29s）
  doubao: 3.29,
}

/**
 * provider/model → 角色 id 的匹配表。
 * 用小写子串匹配 `provider/model`，第一命中即返回。
 * 新增角色追加在末尾，避免新键抢先命中已有角色的路由。
 */
const ROUTES = [
  { id: 'chatgpt', keys: ['chatgpt', 'openai', 'gpt'] },
  { id: 'gemini', keys: ['gemini'] },
  { id: 'claude', keys: ['claude', 'anthropic'] },
  { id: 'kimi', keys: ['kimi', 'moonshot'] },
  { id: 'deepseek', keys: ['deepseek'] },
  { id: 'glm', keys: ['glm', 'zhipu', 'chatglm'] },
  { id: 'qwen', keys: ['qwen', 'tongyi', 'qianwen', '通义'] },
  { id: 'grok', keys: ['grok', 'spacexai', 'xai'] },
  { id: 'minimax', keys: ['minimax', 'hailuo', 'abab'] },
  // 'mimo' 会命中 `xiaomi-token-plan-cn/mimo-v2.5` —— 那本来就是小米 MiMo 模型，该播
  { id: 'mimo', keys: ['mimo', 'xiaomi'] },
  // 'meta' 放在最后：它太短，容易被别的路由名误吃
  { id: 'musespark', keys: ['musespark', 'muse-spark', 'muse_spark', 'meta'] },
  // 豆包 / 火山方舟。用户的模型是 `doubao-seed-2-1-turbo`，provider 就叫 doubao，
  // 所以 'doubao' 一定能命中；'volcengine' 兜住用 provider 别名的情形。
  // 没用 'seed' —— 它太短，别的厂商也有 seed 系模型，容易误吃。
  { id: 'doubao', keys: ['doubao', 'volcengine'] },
]

/**
 * 把一条 provider/model 路由映射到角色 id。
 * @param provider - 供应商 id。
 * @param model - 模型 id。
 * @returns 命中的角色 id；ROUTES 里都没命中时返回 undefined（不播动画）。
 */
function logoIdFor(provider, model) {
  const hay = `${String(provider)}/${String(model)}`.toLowerCase()
  for (const route of ROUTES) {
    for (const key of route.keys) {
      if (hay.includes(key)) return route.id
    }
  }
  return undefined
}

/** 浏览器半边的样式表：全屏居中、轻遮罩、动画期间接管输入。 */
/**
 * 客户端的样式表。**每次调用都读盘。**
 *
 * 原来它是模块级常量 —— import 的时候就求值了，于是改了 CSS 必须重启 dsh web，
 * 光刷新页面没用（用户就撞上过这个，以为是"推送了没用"）。
 * 现在样式表本体放在 lib/client.css，资产前缀用 __DSF_BASE__ 占位，
 * 读出来再替换。改完存盘、刷新页面就能看到。
 */
export function clientCss() {
  return readFileSync(join(PACKAGE_ROOT, 'lib', 'client.css'), 'utf8')
    .split('__DSF_BASE__').join(BASE)
}
/** 资产缓存，避免每次请求都读盘。 */
const assetCache = new Map()

/**
 * 读一个包内资产，命中缓存。
 * @param relativePath - 相对包根目录的路径。
 * @returns 文件内容。
 */
function asset(relativePath) {
  let cached = assetCache.get(relativePath)
  if (cached === undefined) {
    cached = readFileSync(join(PACKAGE_ROOT, relativePath))
    assetCache.set(relativePath, cached)
  }
  return cached
}

/**
 * @param ctx - 宿主 Cordis 上下文。
 * @param config - 插件配置（可选）。
 */
export function apply(ctx, config) {
  const options = config ?? {}
  const enabled = options.enabled !== false
  const volume = typeof options.volume === 'number' ? options.volume : 0.9
  /** 启动音（8-bit 芯片音）开关；音量默认比语音低不少，毕竟是每次切换都响。 */
  const sfx = options.sfx !== false
  const sfxVolume = typeof options.sfxVolume === 'number' ? options.sfxVolume : 0.5
  /**
   * 复古未来音频链（窄带/饱和/位深/抖动/小空间/机械底噪）。
   * 同时作用在**语音和启动音**上 —— 两者听起来像从同一只老喇叭出来的。
   * 参数是听感定稿的；要调请对着 tools/voice-fx-lab.html 调完再改常量。
   */
  const fx = options.fx !== false

  /** 在线的浏览器连接（SSE）。没有连接时不广播。 */
  const clients = new Set()
  /**
   * 每个 session 上一次已处理的「选择事件序号」。
   *
   * 这一层防的是**同一个事件被回调两次**（onChanged 在 request/header 上也会触发）。
   */
  const seenSeq = new Map()
  /**
   * 每个 session **上一次实际播过**的路由。
   *
   * 这一层防的是「只调了 reasoning effort 也弹过场」：改 low/high/max 会写一条
   * model/selection，但 provider/model 没变，那不是换模型。
   *
   * 为什么不直接跟 `lastUsed` 比：lastUsed 只在**发请求**时才更新，
   * 连切两次模型时它还是旧的，会把第二次误判成「没换」。
   * 而这张表为空时（首次选择）一定放行 —— 所以「默认模型点不动」也不会再出现。
   */
  const lastPlayed = new Map()
  /** 最近的观测记录（环形缓冲），由 /state 端点暴露，便于诊断。 */
  const recent = []
  let seq = 0

  /** 向所有在线浏览器推送一帧。 */
  const broadcast = (payload) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`
    for (const res of clients) {
      try {
        res.write(frame)
      } catch {
        clients.delete(res)
      }
    }
  }

  /** 已注册的 webServer 路由，卸载时逐个撤销。 */
  const disposers = []

  if (enabled) {
    // ── 角色语音 ───────────────────────────────────────────────────────────
    for (const id of Object.keys(VOICES)) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `${BASE}/voice/${id}.mp3`,
        handler: (req, res) => {
          try {
            const bytes = asset(join('assets', `${id}.mp3`))
            res.writeHead(200, {
              'content-type': 'audio/mpeg',
              'content-length': String(bytes.length),
              'cache-control': 'public, max-age=3600',
            })
            res.end(bytes)
          } catch (error) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(`voice unavailable: ${String(error && error.message || error)}`)
          }
        },
      }))
    }

    // ── 颗粒质感贴图（64×64 平铺）───────────────────────────────────────────
    // 预渲染成图而不是用 <feTurbulence>：后者逐帧重新求值，会把描边动画拖掉帧。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/grain.png`,
      handler: (req, res) => {
        try {
          const bytes = asset(join('assets', 'grain.png'))
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': String(bytes.length),
            'cache-control': 'public, max-age=86400',
          })
          res.end(bytes)
        } catch (error) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`grain unavailable: ${String(error && error.message || error)}`)
        }
      },
    }))

    // ── 浏览器脚本 ─────────────────────────────────────────────────────────
    // **每次请求都读盘，不走 assetCache。**
    // 原来这里写的是 asset(...)，而 asset() 会把内容存进进程内的 assetCache ——
    // 于是第一次请求之后，磁盘上改了也一直发旧的那份，
    // 看起来就是"改了没用"（用户就撞上过这个）。
    // 这个文件是开发时改得最勤的一个，用缓存换来的那点性能完全不值得。
    // 音频和 grain.png 走 asset() —— 那些是真正的静态资产，不会改。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/client.js`,
      handler: (req, res) => {
        try {
          const bytes = readFileSync(join(PACKAGE_ROOT, 'lib', 'client.js'))
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'content-length': String(bytes.length),
            'cache-control': 'no-store',
          })
          res.end(bytes)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`client unavailable: ${String(error && error.message || error)}`)
        }
      },
    }))

    // ── play 指令通道（SSE）───────────────────────────────────────────────
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/events`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        clients.add(res)
        const drop = () => { clients.delete(res) }
        res.on('close', drop)
        res.on('error', drop)
      },
    }))

    // ── 播完回报（没有闸门等它，留着便于观察/调试）─────────────────────────
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/done`,
      handler: (req, res) => {
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
      },
    }))

    // ── 诊断：最近若干次模型选择观测记录 ────────────────────────────────────
    // 出问题时 `curl http://127.0.0.1:3080/model-switch-fx/state` 就能看到
    // 「观测到什么路由、匹配到谁、为什么播/没播」，不用猜。
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/state`,
      handler: (req, res) => {
        const body = JSON.stringify({
          clients: clients.size,
          voices: VOICES,
          routes: ROUTES,
          recent,
        }, null, 2)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': String(Buffer.byteLength(body)),
        })
        res.end(body)
      },
    }))

    // ── 把样式表和脚本挂进 index.html ──────────────────────────────────────
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'style', text: clientCss() })
      table.push({ kind: 'script-preload', src: `${BASE}/client.js` })
      table.push({ kind: 'script-src', placement: 'body', src: `${BASE}/client.js` })
    })

    // ── 触发点：用户一换模型就播 ────────────────────────────────────────────
    // 注意：onChanged 内部用服务自己的 ctx.effect 注册监听，
    // 不会随本插件的 fiber 卸载 —— 必须显式调用它返回的 disposer，
    // 否则插件重载后旧监听会残留（一次换模型播多遍）。
    const stopWatching = ctx.sessionProjections.onChanged((session, key, value, rev) => {
      if (key !== 'modelSelection') return

      const state = ctx.sessionProjections.stateOf(session, 'modelSelection')
      const pending = state?.pending
      const lastUsed = state?.lastUsed ?? null
      const route = pending === null || pending === undefined
        ? null
        : `${pending.provider}/${pending.model}`
      const id = pending === null || pending === undefined
        ? undefined
        : logoIdFor(pending.provider, pending.model)

      /** 记一笔观测记录，便于事后诊断。 */
      const note = (reason, extra) => {
        recent.push({
          at: new Date().toISOString(),
          session: String(session.id),
          route,
          lastUsed: lastUsed === null ? null : `${lastUsed.provider}/${lastUsed.model}`,
          matched: id ?? null,
          reason,
          ...extra,
        })
        if (recent.length > 60) recent.shift()
      }

      if (pending === null || pending === undefined) { note('no-pending'); return }

      // 只调 reasoning effort（low/high/max）时，也会写一条 model/selection，
      // 但 provider/model 没变 —— 那不是「换模型」，不该弹过场。
      // 判据用**上一次实际播过的路由**，不用 lastUsed：
      //   · lastUsed 只在发请求时才更新，连切两次模型时会误判
      //   · 首次选择时它是空的，所以第一次一定会播（这修掉了「默认模型点不动」）
      //   · 同一个模型再点一次也不会播 —— 那本来就不是切换
      if (lastPlayed.get(session.id) === route) { note('same-as-last-played'); return }

      // 去重键 = 引起本次变化的事件序号（onChanged 的第 4 个参数）。
      // 一个「选择了模型」的事件 = 一个 seq，天然精确：同一次选择的重复回调会
      // 带着相同 seq 被挡掉，而用户再点一次同一个模型是新事件、新 seq，照播。
      if (rev !== undefined && rev !== null) {
        if (seenSeq.get(session.id) === rev) { note('already-handled-this-event'); return }
        seenSeq.set(session.id, rev)
      }

      // 不在 ROUTES 里就不播（记录成 unmatched，方便看出哪条路由没被识别）
      if (id === undefined) { note('unmatched-route'); return }

      if (clients.size === 0) { note('no-browser-connected'); return }

      note('played')
      lastPlayed.set(session.id, route)
      broadcast({
        type: 'play',
        id,
        token: `dsf-${++seq}`,
        voice: VOICES[id],
        volume,
        sfx,
        sfxVolume,
        fx,
      })
    })
    disposers.push(stopWatching)
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载期单个路由取消失败不该打断其余清理
      }
    }
    clients.clear()
    seenSeq.clear()
    recent.length = 0
  }, 'dsh-model-switch-fx: routes and selection watcher')
}
