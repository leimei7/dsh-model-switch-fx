# dsh-model-switch-fx

> DSH Web 插件：**在模型选择器里换一个模型，屏幕中央立刻播放对应 AI 娘的 logo 描边动画与角色语音。**

触发点是「选择的当下」—— 换完模型立刻就弹，不等你发消息，**也不拦截、不阻塞任何请求**。

零依赖、零构建。宿主半边是纯 ESM，浏览器半边是经典脚本，都不用打包器。

---

## 效果

一次「科幻片操作系统过场」：

- 铺满视口的遮罩：**只有一圈很轻的中央压暗**，不做背景虚化（直接显示，界面仍然清晰可读）
- 整体**居上一点**（根容器留了 `padding-bottom:20vh`）
- logo **描边逐段绘制** → 实心淡入 → 保持发光 → 停留 → 淡出
- logo 下方浮出**英文公司名**（`OPENAI` / `GOOGLE DEEPMIND` / …）
- **语音不是一开场就响**：等描边动起来（640ms）再出声
- 动画期间是**模态**：遮罩接管指针，键盘也被拦下（保留 Ctrl/Cmd 组合），播完自动解锁
- 每个角色有自己的声线

### 时间轴

```
0ms                淡入开始
380ms              描边开始（所有路径同时画）
640ms              语音开始          ← 不是立刻出声
640+语音            语音结束
3780ms             描边完成 → 实心淡入 + 公司名浮现
5580ms             公司名完整可见（含 600ms 淡入）
总时长-800ms        开始淡出          ← 期间仍然接管输入
总时长              结束解锁
```

```
总时长 = max(语音约束, 名字约束)
       = max(640 + 语音时长 + 1300,  3780 + 1800 + 800)
       = max(语音约束,  6380)
```

不固定总时长，而是**固定节奏结构**，让总时长跟着语音走。两个约束各有原因：

- **语音约束**（`语音 + 1300`）保证语音放完之后只留 1.3s 收尾。如果固定总时长，
  短语音（ChatGPT 3.2s）后面会剩近 3 秒静音 —— 那时 logo 早画完、画面毫无变化，显得「空」。
- **名字约束**（`名字浮现 + 1800 + 800`）保证公司名浮现后**完整可见 1200ms 才开始淡出**。
  名字自己的淡入要 600ms，所以这个值必须明显大于 600ms ——
  否则名字**还没到全不透明就开始往下淡**，看起来就是「刚弹出来就没了」。

### 角色一览

| 角色 | 公司名 | 命中 provider/model | 台词 | 语音 | 总时长 |
|------|--------|--------------------|------|:---:|:---:|
| ChatGPT 娘 | OpenAI | `openai` / `chatgpt` / `gpt` | Hello. I'll catch you. ChatGPT online. | 3.20s | 6.38s |
| Gemini 娘 | Google DeepMind | `gemini` | Hello. Extremely brilliant! Gemini online. | 3.52s | 6.38s |
| Claude 娘 | Anthropic | `claude` / `anthropic` | Hello. You're absolutely right. Claude online. | 4.48s | 6.42s |
| Kimi 娘 | Moonshot AI | `kimi` / `moonshot` | Hello. Let me read. Kimi online. | 3.36s | 6.38s |
| DeepSeek 娘 | DeepSeek | `deepseek` | Hello. Just one bowl? DeepSeek online. | 4.16s | 6.38s |
| GLM 娘 | Zhipu AI | `glm` / `zhipu` / `chatglm` | Hello. I raise first. GLM online. | 3.84s | 6.38s |
| Qwen 娘 | Qwen | `qwen` / `tongyi` / `qianwen` | Hello. Naturally. Qwen online. | 3.36s | 6.38s |
| Grok 娘 | SpaceXAI | `grok` / `spacexai` / `xai` | Hello. Miss me? Grok online. | 3.04s | 6.38s |
| MiniMax 娘 | MiniMax Group Inc. | `minimax` / `hailuo` / `abab` | Hello. Hmm, well. MiniMax online. | 5.44s | 7.38s |
| MuseSpark 娘 | Meta | `musespark` / `muse-spark` / `meta` | Hello. What's up? MuseSpark online. | 3.36s | 6.38s |
| MiMo 娘 | Xiaomi MiMo | `mimo` / `xiaomi` | Hello. Let's go! MiMo online. | 4.48s | 6.42s |

匹配走 `provider/model` 的**小写子串**，第一命中即返回。所以：

- 模型**显示名**和 **id** 可能不同 —— 例如选择器里显示 `DeepSeek-V41-Flash`，
  实际 id 是 `deepseek-flash`。两种写法都能命中。
- `meta`、`mimo` 这类短键容易误伤别的路由名，所以它们在匹配表**最后**。
- 不在上表里的模型（例如 `some-vendor/unknown-x1`）不播动画。

---

## 安装

### 方式一：从 GitHub 装（推荐）

```bash
dsh plugin --profile web add github:leimei7/dsh-model-switch-fx
```

> **这个插件零依赖、零构建，没有 `prepare` 脚本。**
> 所以不会撞上 pnpm ≥10 拦截 git 依赖构建脚本那个坑
> （DSH 在 `dsh plugin` 失败时会提示你去 `pnpm-workspace.yaml` 加 `allowBuilds` 白名单，
> 这个插件不需要）。

也可以用任意 git 地址或 `.git` 结尾的 URL：

```bash
dsh plugin --profile web add git+https://github.com/leimei7/dsh-model-switch-fx.git
```

### 方式二：从 npm 装

```bash
dsh plugin --profile web add dsh-model-switch-fx
```

### 方式三：本地开发用

```bash
git clone https://github.com/leimei7/dsh-model-switch-fx.git
dsh plugin --profile web add link:/绝对路径/dsh-model-switch-fx
```

装完**重启 `dsh web`**（配置树在启动时组装），然后刷新页面。

也可以不用 CLI，直接在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: model-switch-fx
      name: 'dsh-model-switch-fx'
```

### 卸载

```bash
dsh plugin --profile web remove dsh-model-switch-fx
```

---

## 配置

```yaml
- insert:
    - id: model-switch-fx
      name: 'dsh-model-switch-fx'
      config:
        enabled: true    # false = 整个动画关掉
        volume: 0.9      # 语音音量 0~1
```

---

## 触发链路

```
用户在 composer 的模型座位上选了另一个模型
        ↓  客户端 session.selectModel
宿主 agent.session.append('model/selection', selection)     ← 选择时就写入了
        ↓
modelSelection 投影的 pending 更新
        ↓
本插件在 sessionProjections.onChanged 里收到通知
        ↓  SSE
浏览器播动画 + 语音
```

因为触发时还没有任何 LLM 请求，所以**不拦截、不阻塞任何流程** ——
纯粹是一个即时的视觉/听觉反馈。

### 去重按「事件」而不是「路由」

`onChanged(session, key, value, seq)` 的第 4 个参数 `seq` 是**引起本次变化的事件序号**。
一个「选了模型」的事件 = 一个 `seq`，所以按 `(session, seq)` 去重是精确的：
同一次选择的重复回调带相同 `seq` 会被挡掉，而用户再点一次同一个模型是新事件、新 `seq`，照播。

> 早期版本按**路由**去重，还额外加了一条 `sameRoute(pending, lastUsed)` 规则，
> 结果吃掉了一整个场景：**当某个角色正好是当前默认模型时**，用户在选择器里点它，
> `pending` 与 `lastUsed` 相同 → 被判成「没换模型」直接跳过。
> `deepseek-official/deepseek-flash`（选择器显示 `DeepSeek-V41-Flash`）就是默认模型，
> 所以看起来像「识别不了」—— 其实匹配一直是对的。

---

## 诊断

出问题时先看这个端点，它记录了最近 60 次模型选择的观测与判定：

```bash
curl -s http://127.0.0.1:3080/model-switch-fx/state
```

返回 `{ clients, voices, routes, recent: [...] }`，每条 `recent` 含
`route`（实际观测到的 provider/model）、`matched`（匹配到哪个角色）以及 `reason`：

| reason | 含义 |
|--------|------|
| `played` | 已广播播放 |
| `no-browser-connected` | 匹配到了但没有在线浏览器，没播 |
| `unmatched-route` | 不在角色表里（看 `route` 就知道是什么没被识别） |
| `already-handled-this-event` | 同一次选择事件被重复通知，已处理过（按 `seq` 去重） |
| `no-pending` | 没有待生效的新选择（通常来自 `request/header` 事件） |

**「我切了但没反应」的正确排查顺序**：先看 `/state` 里最后一条的 `reason`。
如果是 `unmatched-route`，说明是匹配表缺键；如果是 `no-browser-connected`，说明页面没连上 SSE。

---

## 自己加一个角色

整条流水线是「单一事实来源」的，加一个角色大约五步。

### 1. 在 `showcase.html` 里加一页

`showcase.html` 是 logo 路径数据的**唯一事实来源**，同时也是一个不依赖 DSH 的独立展示页
（浏览器直接打开就能逐个看，空格 / 方向键翻页）。

````html
<!-- ========== 12. Foo ========== -->
<div class="page" data-i="11">
  <div class="logo-box">
    <div class="glow" style="background:#7C6BF0"></div>
    <svg viewBox="0 0 24 24" style="--gc:#7C6BF0">
      <defs><filter id="f12"><feDropShadow stdDeviation=".5" flood-color="#7C6BF0" flood-opacity=".85"/>
        <feDropShadow stdDeviation="1.8" flood-color="#7C6BF0" flood-opacity=".4"/></filter></defs>
      <g filter="url(#f12)">
        <path class="anim" stroke="#7C6BF0" stroke-width=".3" fill-rule="evenodd" d="M..."/>
      </g>
    </svg>
  </div>
  <div class="t" style="color:#7C6BF0">FOO</div>
  <div class="sub">Foo Inc. · 说明文字</div>
</div>
````

要点：

- `data-i` 从 0 开始顺延
- 一个角色可以有多条 `<path class="anim">`（OpenAI 就是 6 瓣）
- 记得给 `CFG` 数组补一条 `{draw:2.8, stagger:0}`
- 快速拿官方路径的办法：从 [LobeHub Icons](https://github.com/lobehub/lobe-icons) 取
  `@lobehub/icons-static-svg` 里的 `.svg`，把 `<path d="...">` 抄过来

### 2. 生成语音

放 `assets/<id>.mp3`（24000 Hz 单声道最省事）。台词约定是
`Hello. [口癖]. [Model] online.`

### 3. 把路径抽进 `lib/client.js`

```bash
node tools/gen-logos.mjs
```

它按 `showcase.html` 里的页面顺序解析，用 `TITLE_TO_ID` 的映射决定角色 id
（**记得在 `tools/gen-logos.mjs` 里补上新标题**），然后注入 `lib/client.js` 的 `LOGOS` 区块。

> 别手抄路径。Claude 1.8k、GLM 2.0k、DeepSeek 3.5k 字符，手抄必然出错。

### 4. 填三张表

| 文件 | 表 | 加什么 |
|------|-----|--------|
| `lib/index.js` | `VOICES` | `<id>: 语音秒数`（用 `ffprobe` 量） |
| `lib/index.js` | `ROUTES` | `{ id: '<id>', keys: ['<匹配键>'] }` |
| `lib/client.js` | `COMPANY` | `<id>: '公司英文名'` |

### 5. 跑测试

```bash
node tools/test-watch.mjs        # 宿主逻辑，含「真实路由 → 角色」对照表
node tools/test-takeover.mjs     # 浏览器端（需先起 preview）
```

新角色记得加进 `test-watch.mjs` 的路由对照表——它现在是常驻断言。

---

## 目录结构

```
lib/index.js       宿主半边：路由、SSE、投影变更监听（零依赖，无构建）
lib/client.js      浏览器半边：动画 + 语音（经典脚本，无依赖、无打包器）
assets/*.mp3       11 段角色语音
showcase.html      独立展示页 + logo 路径的唯一事实来源（改 logo 改这里）
cordis.patch.yml   插件挂载点
tools/
  gen-logos.mjs      从 showcase.html 提取 logo 路径数据
  preview.mjs        独立预览服务器，不开 DSH 也能调动画
  test-watch.mjs     宿主侧触发 / 去重 / 路由匹配自测
  test-takeover.mjs  浏览器端：接管、模态、公司名、染色断言
  probe-frames.mjs   逐帧状态探针（查「闪一帧」这类单帧问题）
  dense-capture.mjs  按固定间隔密集抓帧
  shot-fx.mjs        对预览页做实时截图
```

## 开发与测试

```bash
node tools/preview.mjs                            # http://127.0.0.1:5199/ 点按钮逐个看
node tools/test-watch.mjs                         # 宿主侧全部断言
node tools/test-takeover.mjs                      # 浏览器端断言（需先起 preview）
node tools/probe-frames.mjs chatgpt 16 takeover   # 逐帧核对有没有剧透帧
node tools/dense-capture.mjs chatgpt 300          # 密集抓帧看动画瑕疵
node tools/gen-logos.mjs                          # 改了 showcase.html 后重新提取
```

后四个工具需要 Chrome（CDP 驱动）。默认会自动探测常见安装路径，
也可以显式指定：

```bash
DSH_FX_CHROME=/path/to/chrome node tools/shot-fx.mjs
```

---

## 实现要点（踩过的坑）

这一节记录几个**改回去就会出问题**的点，都是实际踩出来的。

### 1. 浮层变可见前，图形必须已经处于「未绘制」状态

否则会闪出一帧完整 logo —— 肉眼看到的「剧透帧」。曾经依赖
「`appendChild` 到摘掉 `dsf-drawn` 之间不会有绘制」（靠同一个任务内不重绘），
这个假设太脆：中间只要有一步强制样式重算就会漏。

更确定的一个漏洞是：`close()` 忘了清 `dsf-drawn`，播放完成后那个类一直留在 root 上，
于是下一次播放时新的实心层是**带着 `opacity:1`** 插进去的。

现在 `show()` 是显式六步：

1. 摘掉 `dsf-drawn` / `dsf-out` —— **必须在插入新图形之前**
2. 换图形
3. 用**内联样式**把描边层钉死在隐藏态 —— 不依赖注入的 CSS，样式表顺序或被覆盖都不影响
4. `void root.offsetWidth`：提交这个隐藏态（此时浮层还没 `dsf-on`，看不见）
5. 布 WAAPI 动画（`fill:'both'` 让延迟期继续维持首帧）
6. **到这里才** `dsf-on` + `lockInput()`

第 4 步那个重排有个好副作用：`dsf-on` 从「初始样式」变成了「样式变更」，
所以浮层会正常淡入 300ms（否则是瞬现）。

### 2. 内联钉死的隐藏态，必须记得撤销

第 3 步给实心层也设了内联 `opacity:0`。**内联优先级最高**，所以 CSS 里那条
`#dsf-root.dsf-drawn .dsf-solid{opacity:1}` 永远盖不过它 —— 结果是描边画完之后
**实心层再也不会亮起来**，最终染色动画整个消失（公司名不受影响，因为它没被内联钉，
所以现象是「名字出现了但没染色」）。

```js
if (entry.solid) entry.solid.style.opacity = ''   // 先撤销内联钉死
root.classList.add('dsf-drawn')                   // 再由 CSS 规则接管 → 0 淡入到 1
```

### 3. 未开始的路径必须设 `opacity: 0`

`stroke-dasharray: 1000` + `stroke-dashoffset: 1000` 时，**虚线边界正好压在路径起点上**，
配合 `stroke-linecap: round`，零长度的虚线头会渲染成一个**小圆点**。
OpenAI 那个 6 花瓣 logo 会先出现一圈孤立的小点，看起来像渲染坏了。

修法是在 keyframes 里带 `opacity`，并让动画用 `fill: 'both'`：

```js
[
  { opacity: 0, strokeDashoffset: DASH_LEN },
  { opacity: 1, strokeDashoffset: DASH_LEN, offset: 0.02 },
  { opacity: 1, strokeDashoffset: 0 },
]
```

`fill: 'forwards'` 不行 —— 延迟期间会退回 CSS 的基础样式（`opacity` 为 1），点就露出来了。

### 4. 多路径**不要**逐条错开

试过让 OpenAI 的 6 个花瓣逐条错开（相邻 340ms），结论是**观感更差**：
错开时每个时刻只有 1~2 片花瓣在动，早期画面是几根互不相连的短线；
同时绘制反而是「6 个方向均匀绽放」，更像一朵花在开。

所以所有路径**同一时长、同一延迟**。

### 5. 淡出不要摘 `dsf-on`

`#dsf-root.dsf-on` 同时管着**不透明度**和**指针接管**。如果用它来触发淡出，
那 800ms 里 `pointer-events` 已经变回 `none`（鼠标能点穿到下层），
但键盘锁定要到淡出结束才解除 —— 两者不一致。

所以淡出用独立的 `#dsf-root.dsf-out`（只改不透明度 + 自己的 .8s 过渡），
`dsf-on` 一直留到整段结束，指针和键盘**同时**解锁。

### 6. logo 颜色读法

颜色优先取 `<svg style="--gc:...">`，其次才是 `<g stroke>` ——
因为部分页面把颜色写在 `<path>` 上，只读 `<g stroke>` 会拿到 `null`。

### 7. 发光不能用 CSS `filter` 加在 SVG 根节点上

会和外层的视差 `transform` 冲突，导致整个 logo 不渲染。
所以用 SVG 自带的 `<filter>` + `feDropShadow`。
注意 `feDropShadow` 默认 `dx/dy=2`，在 24 单位的 viewBox 里会被放大成几十像素的偏移，
必须显式设成 `dx=0 dy=0`，并把 `stdDeviation` 按显示尺寸换算。

---

## 已知取舍

- **没有浏览器连接时不广播**：TUI / 页面没打开时什么都不做，不占资源。
- **浏览器静音时动画照播**：autoplay 被策略拦下时听不到声音，但视觉动画不受影响。
- **子代理的模型切换也会触发**：子代理换模型同样会写 `model/selection`，目前不过滤。
  如果觉得吵，可以按 `sessions.subagentAddress()` 过滤掉。
- **连续快速切换是「接管」不是「排队」**：上一段还在播时又切了模型，会立刻拆掉上一段
  播新的那一段。早期版本在这里用布尔守卫直接丢弃，表现为「只能切一次」。
- **重新点当前正在用的模型也会播**：用户确实点了，就该有反应。
- **动画期间页面不可操作**：遮罩接管指针，并且捕获阶段拦下不带修饰键的 keyboard /
  contextmenu / dragstart。Ctrl / Cmd / Alt 组合仍然放行，所以刷新和开发者工具不会被锁死。
- **背景不做虚化**：只有 `#dsf-dim` 那圈很轻的中央压暗。曾经用过 `backdrop-filter: blur(9px)`，
  观感偏「糊」，而且整个视口持续重合成会掉帧。想加回来，给 `#dsf-dim` 补一行即可。
- **语音时长改动后要同步 `VOICES`**：那个表是用来算动画总时长的，写错会让收尾错位。
  用 `ffprobe -v error -show_entries format=duration -of csv=p=0 assets/<id>.mp3` 量。

---

## License

MIT

## 商标声明

本项目出现的所有品牌 logo 均为其各自所有者的注册商标或商标，
**仅用于识别对应的 AI 服务**，不代表任何形式的授权、合作或背书。

- logo 矢量路径取自 [LobeHub Icons](https://github.com/lobehub/lobe-icons)（MIT）
- 角色语音由 MiMo TTS 按各角色人设生成后做后期处理
