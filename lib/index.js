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
  // 唯一的中文角色（台词「你好，完全没问题！豆包已连接」），实测 3.00s
  doubao: 3.0,
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
export const CLIENT_CSS = `
#dsf-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;
  display:flex;align-items:center;justify-content:center;
  /* 内容整体居上一点：底部留白把居中块往上推（推 padding 的一半）。
     视觉重心略高比正中间好看，也给下方留出呼吸空间。 */
  padding-bottom:20vh;
  opacity:0;transition:opacity .3s ease}
/* 动画期间接管输入：像一次真正的系统切换，不允许操控下层页面 */
#dsf-root.dsf-on{opacity:1;pointer-events:auto;cursor:progress}
/* 淡出必须用单独的 class：直接移除 dsf-on 会连指针接管一起撤掉，
   于是淡出的那 800ms 里鼠标已经能点穿到下层，键盘却还锁着 —— 不一致。
   独占一条规则且排在 dsf-on 之后，所以两者同时存在时以淡出的透明度为准。 */
#dsf-root.dsf-out{opacity:0;transition:opacity .8s ease}
/* 背景处理：只有一圈很轻的中央压暗，不做虚化。
   虚化（backdrop-filter）虽然好看，但整个视口持续重合成，低端机掉帧，
   而且会把下层界面糊掉 —— 直接显示更干净。 */
#dsf-dim{position:absolute;inset:0;
  background:radial-gradient(ellipse at 50% 50%,
    rgba(3,4,10,.62) 0%,rgba(3,4,10,.34) 42%,rgba(3,4,10,0) 72%)}
/* 颗粒质感：预渲染的 64×64 噪声平铺（不是 <feTurbulence> —— 那个逐帧重算会掉帧，
   也不用 base64 内联 —— 随机噪声压不动，会让每次页面加载多背 20KB）。
   静态不动：颗粒属于「屏幕」而不是画面内容，所以它不该跟着 logo 动。
   想调强弱就改这里的 opacity；想整体关掉就把这条规则删掉。 */
#dsf-dim::after{content:'';position:absolute;inset:0;pointer-events:none;
  background-image:url(${BASE}/grain.png);background-repeat:repeat;
  opacity:.055}
/* 光晕跟随描边渐入：一开场就满强度的话，logo 还只是几条短线时
   会先出现一团孤立的绿云，和图形脱节。所以透明度走 transition 慢慢起，
   呼吸只动 transform（否则 animation 会盖掉 transition 的透明度）。
   它挂在 #dsf-stage 内部，尺寸按 stage 的百分比算 —— 布局怎么挪都跟着走。 */
#dsf-halo{position:absolute;left:50%;top:50%;width:150%;height:150%;
  transform:translate(-50%,-50%) scale(.72);border-radius:50%;filter:blur(90px);opacity:0;
  transition:opacity 2.2s ease .4s,transform 2.2s ease .4s}
#dsf-root.dsf-on #dsf-halo{opacity:.3;transform:translate(-50%,-50%) scale(1);
  animation:dsf-halo 3.2s ease-in-out 2.6s infinite}
@keyframes dsf-halo{0%,100%{transform:translate(-50%,-50%) scale(.97)}
  50%{transform:translate(-50%,-50%) scale(1.09)}}
/* 减少动态效果：关掉光晕的**持续呼吸**（那是一直在动的），描边本身在 JS 里跳过。
   淡入淡出保留 —— 那是「变化」不是「运动」。 */
@media (prefers-reduced-motion:reduce){
  #dsf-root.dsf-on #dsf-halo{animation:none}
  #dsf-halo{transition-duration:.5s;transition-delay:0s}
  #dsf-root{transition-duration:.15s}
  #dsf-root.dsf-out{transition-duration:.4s}
}
#dsf-core{position:relative;display:flex;flex-direction:column;align-items:center;gap:36px}
#dsf-stage{position:relative;width:min(54vw,450px,50vh);height:min(54vw,450px,50vh)}
/* SVG 必须压在光晕之上：光晕是绝对定位的，不提升的话会盖住图形 */
#dsf-stage svg{position:relative;z-index:1;width:100%;height:100%;overflow:visible;display:block}
#dsf-stage svg path{stroke-linecap:round;stroke-linejoin:round}
#dsf-stage .dsf-outline path{fill:none;stroke-dasharray:1000;stroke-dashoffset:1000}
#dsf-stage .dsf-solid{stroke:none;opacity:0;transition:opacity .9s ease}
#dsf-root.dsf-drawn .dsf-solid{opacity:1}
/* 公司名：描边画完后浮出 */
#dsf-company{font:600 clamp(17px,1.95vw,26px)/1 'Bahnschrift','DIN Alternate','Arial Narrow',Consolas,monospace;
  letter-spacing:.36em;text-indent:.36em;text-transform:uppercase;white-space:nowrap;
  color:var(--dsf-c,#fff);opacity:0;transform:translateY(10px);
  transition:opacity .6s ease,transform .6s ease;
  text-shadow:0 0 14px var(--dsf-c,#fff),0 0 44px var(--dsf-c,#fff)}
#dsf-root.dsf-drawn #dsf-company{opacity:.95;transform:none}
`

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
   * 去重必须按**事件**而不是按**路由**：按路由去重会吃掉「某个角色正好是当前
   * 默认模型」的整个场景 —— 例如默认就是 deepseek-official/deepseek-flash
   * （选择器里显示成「DeepSeek-V41-Flash」），用户点它时 pending 与 lastUsed
   * 相同，会被判成「没换模型」跳过，看起来像识别不了。
   */
  const seenSeq = new Map()
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
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/client.js`,
      handler: (req, res) => {
        try {
          const bytes = asset(join('lib', 'client.js'))
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'content-length': String(bytes.length),
            'cache-control': 'no-cache',
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
      table.push({ kind: 'style', text: CLIENT_CSS })
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
