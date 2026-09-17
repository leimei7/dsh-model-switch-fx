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
- 遮罩上有一层**极淡的颗粒质感**（预渲染噪声平铺，`opacity: .055`），静态不动
- **尊重系统的「减少动态效果」偏好**：开了就跳过描边，直接淡入完成态 + 照播语音
- **每个角色的启动音都不一样**（8-bit 芯片音，实时合成，无音频文件），见下方配置一节
- **语音与启动音都过一条复古未来音频链**（老式喇叭窄带 + 过载 + 磁带抖晃 + 箱体反射 + 机械底噪）
- 每个角色有自己的声线，且 11 段做了**响度归一化**（切角色不会忽大忽小）

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
| 豆包姐姐 | ByteDance | `doubao` / `volcengine` | 你好，完全没问题！豆包已连接 | 3.00s | 6.38s |

> 豆包是**唯一的中文角色**（其余 11 个都是英文台词）—— 它的语音来自用户提供的
> 豆包原生录音，不是 TTS 生成，所以音色就是豆包本人的。见下方「语音管线」。

匹配走 `provider/model` 的**小写子串**，第一命中即返回。所以：

- 模型**显示名**和 **id** 可能不同 —— 例如选择器里显示 `DeepSeek-V41-Flash`，
  实际 id 是 `deepseek-flash`。两种写法都能命中。
- `meta`、`mimo` 这类短键容易误伤别的路由名，所以它们在匹配表**最后**。
- 不在上表里的模型（例如 `some-vendor/unknown-x1`）不播动画。

### 语音响度是归一化的

11 段语音是 11 次独立的 TTS 生成，原始响度并不一致。合并进仓库前统一做了
**EBU R128 响度归一化**（`loudnorm`，两遍：先测量再施加恒定线性增益）：

| | 归一化前 | 归一化后 |
|---|---:|---:|
| 整体响度极差（LUFS） | 5.3 dB | **0.6 dB** |
| 最高真峰值 | — | -1.9 dBTP（不削顶） |

> 为什么必须做：原来的后期链末尾是**峰值归一化**（`x / max|x| * 0.92`），
> 所以所有文件峰值都齐，但**平均响度差了 5 dB** —— 峰值归一化 ≠ 响度归一化，
> 动态范围大的语音会被压得更轻。表现就是切角色时忽大忽小。
>
> `linear=true` 保证只施加恒定增益、不做动态压缩，所以**时长和音色都没变**
> （归一化后逐段实测时长与 `VOICES` 表完全一致）。

### 无障碍：尊重「减少动态效果」

系统开启 `prefers-reduced-motion: reduce` 时，**不做描边动画**，直接把完成态
（描边 + 实心染色 + 公司名）淡入 —— 语音照播。
也就是**保留「切到了哪个模型」这个信息，去掉运动本身**。

实现要点：描边是 WAAPI 驱动的，CSS 的 media query 管不到，所以用
`window.matchMedia('(prefers-reduced-motion: reduce)')` 在 JS 里分支。
CSS 那边另外关掉了光晕的**持续呼吸**（那是一直在动的），淡入淡出保留
（那是「变化」不是「运动」）。

时间轴也随之缩短（没有描边要等）：起声延迟 `640ms → 220ms`，
总时长从 `max(640+语音+1300, 6380)` 变成 `max(220+语音+1300, 2600)`。

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

> **这是一个 Web UI 插件，必须装进带 `@deepseek-ai/dsh-web-app` 的 profile**（`web` 就是，
> 它自带 `webServer` 服务）。装进 `tui` / `headless` 这类没有该服务的 profile，
> 启动会失败并报 `dsh-model-switch-fx: pending (waiting for service: webServer)`
> —— 这是 Cordis 的正常依赖行为，不是插件缺陷。
> 同生态的 `dsh-whale-widget` 也是硬声明 `inject = ['webServer', ...]`。

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
        enabled: true      # false = 整个动画关掉
        volume: 0.9        # 语音音量 0~1
        sfx: true          # 启动音（8-bit 芯片音）开关
        sfxVolume: 0.5     # 启动音音量 0~1，默认比语音低不少 —— 每次切换都响
        fx: true           # 复古未来音频链（语音与启动音同时作用）
```

### 复古未来音频链

**语音和启动音都从「同一只老喇叭」出来** —— 六个环节串成一条链，运行时作用，
不重烤任何 MP3（11 段语音保持原样，可调可关可回退）。

| 环节 | 做什么 |
|------|--------|
| 窄带 | 老式喇叭的频响：高通 60→580Hz、低通 16k→2.6kHz、中频共振。**最出味道的一环** |
| 饱和 | 喇叭过载的软削波（tanh 型，2x 过采样） |
| 位深 | 8bit 数码毛刺，轻到不伤可懂度 |
| 抖动 | 磁带转速不稳（调制延迟 + 0.6~2.2Hz LFO） |
| 小空间 | 机箱箱体的反射（程序生成脉冲响应，含三个早期反射） |
| 机械底噪 | 电流嗡鸣（50/100/150/250Hz）+ 嘶声。**只在过场期间出声** |

**顺序有讲究**：饱和排在窄带**之前**。真实信号链是「功放失真 → 喇叭带宽」；
反过来会让饱和加出的高次谐波没被喇叭削掉，结果「古董机」反而成了最亮的。

机械底噪是常驻运行的（起停会有咔哒），靠一个 `noiseGate` 增益控制何时出声，
过场结束随视觉一起收掉 —— **不会一直在后台嗡嗡响**。

要调这条链请用 `tools/voice-fx-lab.html`（六个滑杆 + 七个预设 + 干湿 A/B + 实时频谱），
它和插件里的链是同一套结构。参数定稿后改 `lib/client.js` 的 `FX_PARAMS`。

**一个安全细节**：语音走 Web Audio 有个坑 —— 一旦调了 `createMediaElementSource`，
该元素的声音就只能从 AudioContext 出来。所以代码先确认 `ctx.state === 'running'`
才路由，不满足就退回直连播放（只是没效果，但有声音）。否则 autoplay 被拦时
语音会**彻底没声**。

### 启动音（8-bit 芯片音，实时合成）

**11 个角色各有一个互不相同的启动音**，就像任天堂每个游戏的开机音都不一样：
都短（260~380ms），但都不一样。**没有任何音频文件** —— 全部用 Web Audio 实时合成。

- 脉冲波按傅里叶级数构造：`aₙ = 2/(nπ)·sin(nπ·d)`（`d` 是占空比）—— 这是 2A03 的音色语言
- 三角波做低音（增益 1.4×，因为谐波少、感知响度弱）、噪声通道做「起手嗞」
- 滑音用连续频率斜坡（真机上没有硬件 portamento，是逐帧写周期寄存器做出来的）
- 包络按 2A03 惯用法：起音 0~2 帧 + 衰减 2~6 帧，末端硬截断
- 每个角色的启动音还**移调到该角色声线的调性上**（用 11 段语音实测的基频 F0
  单调映射进 A4~E5 再量化到半音）—— 同一款设备、不同的键

| 角色 | 启动音 | 结构 |
|------|--------|------|
| chatgpt | ① 就绪琶音 | 单声部 · 5 音均匀上行 · duty 25% |
| gemini | ③ 大合奏 | 三声部齐奏 · duty 50% |
| claude | ⑤ 拱形钟琴 | 上-顶-下 · duty 12.5% |
| kimi | ⑩ 级进爬升 | 大二度级进音阶 · duty 50% |
| deepseek | ④ 召唤-回应 | 低音先行 · duty 25% |
| glm | ⑦ 顿号号角 | 同音三击后跳进 · duty 25% |
| qwen | ⑫ 知性上扬 | 4 音上行 + 尾音上挑滑音 · duty 25% |
| grok | ② 磁盘机 | 2 音下行 + 噪声起手 · duty 12.5% |
| minimax | ⑧ 滑音八度 | 连续滑音 + 双八度终结 · duty 50% |
| musespark | ⑥ 和弦击 | 两个 25ms 琶音和弦 · duty 12.5% |
| mimo | ⑨ 锯齿上升 | 跳进-回落-再跳进 · duty 25% |
| doubao | ⑬ 欢快颤音 | 3 音上行 + 尾段快速颤音收束 · duty 25% |

试听与调参在 `tools/sfx-lab.html`（浏览器直接打开，不用起服务）。
它是这些数据的**单一事实来源**：改完跑 `node tools/gen-sfx.mjs` 同步进 `lib/client.js`。

### 时间轴是算出来的，不是写死的

```
总时长 = max(
  audioDelay + 语音 + 1300,                  ① 语音约束
  描边跨度 + 1800 + 800,                      ② 公司名约束
  启动音起手 + 启动音长度 + 留白 + 1800 + 800,  ③ 启动音约束
)
audioDelay = max(640, 启动音起手 + 启动音长度 + 留白)   ← 语音自动给启动音让路
```

所以**音频变长时不用改代码**：加了启动音之后，减少动效模式的起声延迟
从写死的 220ms 自动变成「启动音结束 + 留白」（330ms 的启动音 → 510ms），
总时长随之从 6000ms 变成 6290ms。测试里也因此**不能写死等待时长**，
一律轮询到浮层收起。

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
  gen-sfx.mjs        从 sfx-lab.html 提取启动音数据（程序化合成，无音频文件）
  gen-voice.py       角色语音管线（TTS 或处理现成音频 → 后处理 → 响度归一化）
  measure-f0.py      量每段语音的基频中位数，给该角色的启动音定调性
  preview.mjs        独立预览服务器，不开 DSH 也能调动画
  test-watch.mjs     宿主侧触发 / 去重 / 路由匹配 / 播放指令自测
  test-takeover.mjs  浏览器端：接管、模态、公司名、染色、启动音断言
  probe-frames.mjs   逐帧状态探针（查「闪一帧」这类单帧问题）
  dense-capture.mjs  按固定间隔密集抓帧
  shot-fx.mjs        对预览页做实时截图
  verify-grain.mjs   验证颗粒层真的在渲染（对比开/关的像素标准差）
  sfx-lab.html       启动音试听页 + 调参（浏览器直接打开），也是 SFX 数据的唯一来源
  verify-sfx.mjs     校验试听页的合成结果（音高 / 傅里叶级数 / 差异度 / 映射单调性）
  voice-fx-lab.html  复古未来音频链试听台（窄带/饱和/位深/抖动/小空间/机械底噪）
  verify-voicefx.mjs 校验那条链每个环节都真的改变了信号（THD / 频谱倾斜 / 抖动…）
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

### 3b. 颗粒质感：不要用 `<feTurbulence>`

`#dsf-dim::after` 有一层颗粒，是**预渲染的 64×64 噪声 PNG 平铺**（`assets/grain.png`，走
`/model-switch-fx/grain.png` 路由）。两个刻意的选择：

- **不用 `<feTurbulence>`**：那是 SVG 里最贵的滤镜之一，**逐帧重新求值**。logo 有 6 条路径
  在 3.8 秒内持续重绘（OpenAI）且全在同一个 `<filter>` 组里 —— 把程序化噪声塞进逐帧光栅化
  路径会让描边掉帧。我们**已经因为同样的原因删掉过 `backdrop-filter`**。平铺图走合成器，
  零逐帧成本。
- **不用 base64 内联**：随机噪声压不动，内联会让每次页面加载多背约 20KB。

贴图本身用了**稀疏高对比散点**（白色像素占 17.6%，alpha 非 0 即 255）而不是均匀噪声。
原因：均匀白噪声在近黑遮罩上平均 alpha 太高（127/255），叠加后整体亮度被抬高约 5/255
——那是「发雾」而不是「质感」。二值分布下 `std/mean = sqrt((1-p)/p)`，p≈0.18 时约 2.16，
同样的纹理只需一半的亮度代价。实测：

| 贴图 | 亮度抬高 | 纹理强度(σ) | 体积 |
|---|---:|---:|---:|
| 均匀噪声 | 5.11 | 4.32 | 3335 B |
| 稀疏散点 | **1.93** | **4.93** | **800 B** |

**调强弱**：改 `#dsf-dim::after` 的 `opacity`；**整体关掉**：删掉那条规则。
`tools/verify-grain.mjs` 用「开/关颗粒时同一块平坦区域的像素标准差之比」来验证它真的在渲染。

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
