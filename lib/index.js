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
export const CLIENT_CSS = `
#dsf-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;
  display:flex;align-items:center;justify-content:center;
  /* 内容整体居上一点：底部留白把居中块往上推（推 padding 的一半）。
     视觉重心略高比正中间好看，也给下方留出呼吸空间。 */
  padding-bottom:20vh;
  opacity:0;transition:opacity .3s ease}
/* 动画期间接管输入：像一次真正的系统切换，不允许操控下层页面。
   鼠标**直接隐藏**（cursor:none）而不是给转圈 —— 系统切换的时候不该看得见指针；
   遮罩铺满视口，所以整个页面都看不见；dsf-on 摘掉时自然回来。
   （原先写的是 cursor:progress，那个小圈反而像页面卡住了。） */
#dsf-root.dsf-on{opacity:1;pointer-events:auto;cursor:none}
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
/* ══ 启动动画（<kiki:on> / <kiki:off> 的仪式）═══════════════════════════
   浮层是一台**老式电子屏幕** —— 一台摆在房间里的机器，不是一块黑布。

   资料原话：「A CRT look is not one effect, it is four:
   scanlines, curvature, phosphor bloom and mains flicker.」
   我第一版只做了扫描线 —— 曲率、磷光辉光、电源闪烁三个都没有，所以"电子屏幕感不明显"。
   现在四个都补齐。

   曲率是**两个**效果合起来装成一个（资料原话）：
     · 玻璃边缘 = 外壳上一个大圆角，屏幕裁在里面
       —— **只做圆角会得到一个"圆角矩形"，那读起来是现代设备，不是显像管**
     · 光学衰减 = 另一层径向渐变把四角压暗
   两层都在。

   层次：① 房间（后面的页面，暗）
        ② 屏幕外壳的玻璃厚度（内阴影 + 一圈高光）
        ③ 屏幕内部：磷光辉光 → 两个记号 + 字标 → 屏幕结构（反光/荫罩/扫描线/暗角/刷新带/闪烁/颗粒）
   **③ 里的屏幕结构必须盖在记号之上** —— 不然记号看着像贴在屏幕外面的。 */
#dsf-boot{position:fixed;inset:0;z-index:2147483000;pointer-events:none;
  /* 房间：后面的页面还在，压暗 —— 屏幕是摆在它前面的一个物体 */
  background:rgba(3,5,7,.62);
  opacity:0;transition:opacity .34s ease}
#dsf-boot.dsf-on{opacity:1;pointer-events:auto;cursor:none}
#dsf-boot.dsf-out{opacity:0;transition:opacity .5s ease}

/* 屏幕本体：四周留一圈（外壳），**椭圆大圆角**，内容裁在里面 */
#dsf-boot .b-crt{position:absolute;inset:1.15vmin;
  display:flex;align-items:center;justify-content:center;padding-bottom:5vh;
  border-radius:2.6vmin/3.6vmin;overflow:hidden;
  background:rgba(4,7,10,.87);
  /* 外壳：外沿一圈冷色高光（玻璃切边）+ 内圈一圈暗（玻璃厚度）+ 屏幕自身往内压暗 */
  box-shadow:0 0 0 1px rgba(150,190,215,.11),
             inset 0 0 0 1px rgba(0,0,0,.75),
             inset 0 0 5vmin rgba(0,0,0,.55),
             0 1.8vmin 5.5vmin rgba(0,0,0,.62)}

/* 磷光辉光：整块屏一层柔光。资料里 CRT 四件套之一，我原来完全没做 */
#dsf-boot .b-bloom{position:absolute;inset:-8%;pointer-events:none;
  background:radial-gradient(56% 50% at 50% 46%,
    rgba(255,238,200,.11) 0%,rgba(238,79,164,.055) 40%,
    rgba(0,168,168,.032) 64%,rgba(0,0,0,0) 100%);
  mix-blend-mode:screen}

/* 玻璃反光：**左上角**一块镜面高光（资料点名的位置） */
#dsf-boot .b-glare{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(38% 32% at 21% 11%,
    rgba(205,232,255,.085) 0%,rgba(205,232,255,.024) 46%,rgba(255,255,255,0) 74%),
    linear-gradient(122deg,rgba(205,232,255,.03) 0%,rgba(255,255,255,0) 42%)}

/* 扫描线：**软化 + 放大周期**。资料点名的坑是「1px 硬边扫描线在小数设备像素比下走样」——
   所以不用 1px 硬线，改成 3px 周期的软坡：既没有摩尔纹，也仍读得出栅格。
   荫罩周期 5px，和 3px 错开。 */
#dsf-boot .b-scan{position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;
  background:repeating-linear-gradient(to bottom,
    rgba(0,0,0,.32) 0px,rgba(0,0,0,.06) 0.85px,rgba(0,0,0,0) 1.5px,
    rgba(0,0,0,.06) 2.15px,rgba(0,0,0,.32) 3px)}
#dsf-boot .b-grille{position:absolute;inset:0;pointer-events:none;opacity:.24;mix-blend-mode:overlay;
  background:repeating-linear-gradient(to right,
    rgba(120,255,210,.055) 0 1px,rgba(255,120,180,.05) 1px 2px,
    rgba(120,170,255,.055) 2px 3px,rgba(0,0,0,0) 3px 5px)}

/* 光学衰减：曲率的第二半 —— 四角压暗。只做圆角是没有曲率的 */
#dsf-boot .b-vig{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(130% 130% at 50% 50%,rgba(0,0,0,0) 40%,
    rgba(0,0,0,.34) 70%,rgba(0,0,0,.80) 100%)}

/* 刷新带：一道很淡的亮带缓慢下行 —— 老屏幕最强的**动态**信号 */
#dsf-boot .b-roll{position:absolute;left:-12%;right:-12%;height:26%;pointer-events:none;
  mix-blend-mode:screen;animation:dsf-crt-roll 5.4s linear infinite;
  background:linear-gradient(to bottom,rgba(255,255,255,0) 0%,
    rgba(200,235,255,.05) 46%,rgba(255,255,255,.065) 52%,rgba(255,255,255,0) 100%)}
@keyframes dsf-crt-roll{0%{top:-32%}100%{top:106%}}

/* 电源闪烁（CRT 四件套之四）：不规则、很轻的一层冷光。不是规则正弦 ——
   老机器是"抖"，不是"呼吸"。 */
#dsf-boot .b-flick{position:absolute;inset:0;pointer-events:none;mix-blend-mode:screen;
  background:#cfe6ff;opacity:.012;animation:dsf-crt-flick 4.3s steps(1,end) infinite}
@keyframes dsf-crt-flick{
  0%,100%{opacity:.012} 7%{opacity:.030} 8%{opacity:.008} 9%{opacity:.026}
  33%{opacity:.028} 34%{opacity:.009} 35%{opacity:.024}
  60%{opacity:.034} 61%{opacity:.010} 62%{opacity:.022}
  82%{opacity:.026} 83%{opacity:.009}}

#dsf-boot .b-grain{position:absolute;inset:0;pointer-events:none;opacity:.10;mix-blend-mode:overlay;
  background-image:url(${BASE}/grain.png);background-repeat:repeat}

@media (prefers-reduced-motion:reduce){
  #dsf-boot .b-roll{display:none}
  #dsf-boot .b-flick{animation:none;opacity:.015}
}
#dsf-boot .b-core{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center}
/* 舞台是**联名锁定**的尺寸。两个记号并排（A 匕首玫瑰 · X · B 镜像记号），
   viewBox 1216×480，按**内容**等高排（A 317×317 / B 559×322）。
   尺寸从 900 提到 1180 —— 900 那版 A 只剩 234px，比它单独时（352px）小太多，
   整块读起来"小气"。现在 A ≈ 308px、B ≈ 543px。 */
#dsf-boot .b-stage{position:relative;width:min(94vw,1180px);
  aspect-ratio:1216/480;max-height:76vh}
#dsf-boot .b-stage svg{position:relative;z-index:1;width:100%;height:100%;
  overflow:visible;display:block}
/* 系统的名字。位置与角色过场的公司名同源 —— 它是记号的底座，
   也是整段动画的**落点**（没有它，记号是飘着的）。

   但它**不是排版出来的，是显示出来的**：每一格由八根笔画组成，
   靠点亮哪几根来成形（矢量 / 仪器显示面板的做法）。
   原来用的是一串系统字体（'Bahnschrift','DIN Alternate',...）——
   那有两个毛病：
     · Windows 上是 Bahnschrift、macOS 上是 DIN Alternate，
       同一套 KIKI 在不同机器上是**不同的字**。一个签名最不该这样
     · 就算锁定到 Bahnschrift，它也是 DIN 1451 的克隆 ——
       所有科幻 UI 的默认字。对，但不独特
   改成笔画之后：字形是路径（每台机器一致）、主题正确
   （机器通报自己的名字是被"显示"的）、而且**解码有了着落** ——
   不是换字母，是笔画在乱亮，像显示器在找自己的状态。 */
#dsf-boot .b-word{margin-top:22px;opacity:0;line-height:0}
#dsf-boot .b-word svg{display:block;overflow:visible;
  width:clamp(76px,8.8vw,116px);height:auto;
  filter:drop-shadow(0 0 3px rgba(245,200,66,.5)) drop-shadow(0 0 12px rgba(238,79,164,.25))}
/* 未点亮的笔画不画（opacity 0）—— 段位显示的"灭"就是真的灭 */
#dsf-boot .b-word line{stroke:#C9BFAE;stroke-width:2.3;stroke-linecap:square;opacity:0}
/* 乱亮中的笔画：暗一档，于是"还在找"和"已经锁定"在明暗上也分得开 */
#dsf-boot .b-word line.on{opacity:.78}
/* 已锁定的笔画：全亮、近白 */
#dsf-boot .b-word line.lock{opacity:1;stroke:#FFF9E8}
@media (prefers-reduced-motion:reduce){
  #dsf-boot{transition-duration:.15s}
  #dsf-boot.dsf-out{transition-duration:.35s}
}
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
