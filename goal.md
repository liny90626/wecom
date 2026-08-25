# goal.md — 企微官方上游核查与适配目标（候选 `2.7.260-12`）

> 状态：**本轮 G1/G2/G3 已批准执行**（2026-08-25）。`wecom_mcp` 转为下一轮专项，见 §8。
> 基线：`2.7.260-11`（`65b5b02`），全量 **46 文件 / 612 测试全绿**（本次已复跑确认）。

---

## 0. 一句话结论

**`@wecom/aibot-node-sdk` 没有新版本可升**——`1.0.7`（2026-05-12 发布）仍是 latest，本仓库已经锁在 `1.0.7`。

但官方在 **2026-08-10 ~ 08-17** 做了一轮很大的动作：整套智能机器人协议文档被**重写并换了位置**，同时首次发布了**官方 OpenClaw 插件**与 **wecom-cli**。把新文档 + SDK 1.0.7 的**实际源码行为**与本插件逐条对照后，得到：

| 编号 | 差异 | 性质 | 是否已复现 | 建议 |
| --- | --- | --- | --- | --- |
| D1 | 被企微踢下线时，插件把断连事件当成**一条用户消息**去跑 agent；且 `ws-kicked` 诊断从不触发 | **真实缺陷**，稳定性 | ✅ 已复现 | **做**（G1） |
| D2 | `undici@7.28.0` 命中 1 个 high（5 条 CVE），修复版 `7.29.0` 已发布 | 安全 | 告警可见 | **做**（G2） |
| D3 | 主动推送未带 `chat_type`，服务端按「优先按群聊处理」猜 | 文档明确「建议明确指定」 | 无现网证据 | **做**（G3） |
| D4 | `wecom_mcp` 的 `biz_type` 说明停留在 4 个经验值，官方已给出**完整取值表**；且 `tools/list` 返回体无上限 | 可用性/功能面 | 官方文档实证 | **转下一轮专项**（§8） |

---

## 1. 核查方法与证据来源

| 来源 | 取证方式 | 结论用途 |
| --- | --- | --- |
| npm registry | `npm view @wecom/aibot-node-sdk versions/time` | SDK 版本判定 |
| 官方开发者文档 | `POST /docFetch/fetchCnt`（表单编码，`doc_id`），共取 22 篇正文 + 全量目录树 4447 节点（含每篇 `time` 更新时间戳） | 协议/限额/能力面 |
| SDK 1.0.7 源码 | `node_modules/@wecom/aibot-node-sdk/dist/index.esm.js` 逐段阅读 | SDK **实际**行为（非文档承诺） |
| 官方 OpenClaw 插件 | `npm pack @wecom/wecom-openclaw-plugin@2026.8.17` 后读 `dist/` | 交叉验证「官方自己怎么处理」 |
| 本仓库 | 复现探针 + 全量测试 | 缺陷证实 |

> 官方文档站是 SPA，`WebFetch`/`curl` 只拿得到壳；浏览器工具被安全策略拦。最终走站内 `docFetch` 接口取正文，可复现。

---

## 2. 上游现状（逐项）

### 2.1 SDK：无更新

- `@wecom/aibot-node-sdk` latest = **1.0.7**（2026-05-12），beta = `1.0.7-beta.0`（更早）。本仓库 `package.json` 锁 `1.0.7`，`node_modules` 实装 `1.0.7`。**无需升级。**
- 旁证：官方自家插件依赖 `^1.0.6`，解析结果同样是 1.0.7。
- 官方新增了 **Python SDK**（`aibot-python-sdk`），与 Node 侧无关。

### 2.2 协议文档：2026-08-12 整套重写

旧的「智能机器人 / 智能机器人长连接」（doc 60904，2026-05-25）已被新的「消息接收与发送 / 使用长连接」取代：

| doc_id | 标题 | 更新日 |
| --- | --- | --- |
| 62154 | 概述（连接数量限制、订阅、心跳） | 2026-08-14 |
| 62155 | 接收消息（text/image/mixed/voice/file/video + quote） | 2026-08-13 |
| 62156 | 接收事件（enter_chat / template_card_event / feedback_event / **disconnected_event**） | 2026-08-13 |
| 62157 | 回复消息（stream / markdown / 卡片 / 媒体） | 2026-08-12 |
| 62158 | 主动推送消息（`aibot_send_msg`，**chat_type**） | 2026-08-12 |
| 62159 | 上传临时素材（分片、限额、有效期） | 2026-08-12 |
| 62160 | 模板卡片类型 | 2026-08-13 |

**与本插件现状一致、无需改动的部分**（逐条核对过）：

- stream `content` ≤ **20480 字节** UTF-8 → 本插件 15360（75%），一致。
- 频率 **30 条/分钟、1000 条/小时**（回复与主动推送共用），`<think></think>` 官方渲染折叠思考块 → 与 `2.7.260-11` 的设计前提一致。
- 心跳 30 秒、单机器人**同一时间只允许一条长连接**、订阅不可反复重试 → SDK 内部已实现。
- 欢迎语必须走 `aibot_respond_welcome_msg` 且 5 秒内 → 本插件 `reply.ts:3745` 用的正是 `replyWelcome`，正确。
- 入站 `quote` / `mixed` 结构 → 本插件已支持并有用例。
- 临时素材：单片 512KB、≤100 片、会话 30 分钟、素材 3 天、图片 10MB/语音 2MB/视频 10MB/文件 20MB → SDK 层实现，本插件未越界。

**唯一口径差**：官方写「从首次推送起 **10 分钟**内必须完成刷新」，本插件按实测的 ~6 分钟窗口设计（`BLOCK_PREVIEW_MAX_MS = 300_000`，5 分钟冻结）。本轮**不动**——现值是被 846605/846608 真机行为逼出来的，官方数字是 API 上限而非客户端保证。记为观察项。

### 2.3 新增官方制品（信息项，不改动）

- **`@wecom/wecom-openclaw-plugin@2026.8.17`**——腾讯企微团队官方 OpenClaw 频道插件，走 **wecom-cli + Skills** 路线（16 个 `wecomcli-*` 技能，通过 CLI tool 调能力），与本 fork 的「插件内置 MCP/REST 工具」是两条不同技术路线。
- **`@wecom/cli@1.1.0`**（2026-08-17）。
- 本轮**不评估路线切换**，只作为交叉验证的参照物使用（D1 的处理方式就与官方一致，见 §3.1）。

### 2.4 MCP 能力面：官方给出了完整的 `biz_type` 取值表

MCP 总览（doc 61954，2026-08-17）列出 **11 项能力**：消息 / 邮件 / 文档 / 表格 / 智能表格 / 智能文档 / 待办 / 日程 / 会议 / 微盘 / 通讯录，均已支持；各能力**需成员单独授权**，授权后拿 streamableHTTP URL 或 JSON Config 接入。

关键在 **CLI 概述（doc 61944，2026-08-14）**——它有一张带 **`biz_type` 列**的对照表，而 `biz_type` 正是本插件 `aibot_get_mcp_config` 的那个参数（`transport.ts:89`）：

| 能力 | `biz_type` | 命令/工具前缀 |
| --- | --- | --- |
| 消息 | `msg` | `message_*` |
| 邮件 | `mail` | `mail_*` |
| 文档 | `doc` | `doc_*` |
| 表格 | `doc` | `sheet_*` |
| 智能表格 | `doc` | `smartsheet_*` |
| 智能文档 | `doc` | `smartpage_*` |
| 待办 | `todo` | `todo_*` |
| 日程 | `schedule` | `calendar_*` |
| 会议 | `meeting` | `meeting_*` |
| 微盘 | `disk` | `disk_*` |
| 通讯录 | `contact` | `contact_*` |
| 素材 | `media` | `media_*` |

**校验**：本插件现有的 4 个经验值 `doc` / `meeting` / `todo` / `contact` 在这张表里 **4/4 完全吻合**——这既证明表格适用于 MCP 平面，也证明我们没记错。

**两条只有查文档才能拿到的事实**（先前按工具前缀推断会推错）：

1. **消息是 `msg` 不是 `message`；日程是 `schedule` 不是 `calendar`**——`biz_type` 与命令前缀在这两项上并不同名。
2. **表格 / 智能表格 / 智能文档共用 `biz_type: doc`**，不是三个独立品类。也就是说本插件**今天就已经能驱动智能表格和智能文档**（`category: "doc"` 的 `tools/list` 会一并返回 `sheet_*` / `smartsheet_*` / `smartpage_*`），只是工具描述里从没说过，模型不会去试。

即：去重后 MCP 平面共 **9 个 `biz_type`**（`msg` / `mail` / `doc` / `todo` / `schedule` / `meeting` / `disk` / `contact` / `media`）覆盖 12 项能力，本插件的描述只提了其中 4 个。

> `media`：MCP 侧没有独立的「素材」页，`media_upload` / `media_download` 是**内嵌在 `doc` / `mail` / `disk` 的工具清单里**返回的。它在官方 `biz_type` 表里有独立取值，但 MCP 平面能否单独取到未经实证——G4 里按「附注」处理，不放进主清单。

另有一条运维约束：**文档权限有效期 7 天，到期需成员重新授权**（doc 61954）。

### 2.5 服务端 API 新增：「管理智能文档内容」16 个接口

2026-07-01/02 新增 smartpage（智能文档）整套：发布/取消发布/可见范围、页面结构/增删改、内容块增删改查与导出、数据源与数据表。
本插件 `wecom_doc` 覆盖 wedoc 的 doc / form / spreadsheet / smartsheet 共 43 个 endpoint，**不含 smartpage**。属于**功能扩展**，见 §5。

---

## 3. 差异清单（含复现）

### 3.1 D1【已复现】被踢下线 → 插件当成用户消息跑了一轮 agent

**协议事实**（doc 62156）：同一机器人建立新连接并订阅成功后，企微向**旧连接**推送 `disconnected_event`，随后主动断开。「收到此事件后，开发者应停止使用当前连接」。

**SDK 1.0.7 的实际行为**（源码确认）：收到该事件后 → `onMessage` 分发给上层 → `stopHeartbeat()` → `clearPendingMessages()` → `isManualClose = true`（**故意不重连**）→ `ws.terminate()`；对上层同时发出两个信号：通用 `event` + 具名 `event.disconnected_event`，以及 `disconnected(reason)`，reason 固定为
`New connection established, server disconnected this connection`。

**本插件现状**（两处独立问题）：

1. `sdk-adapter.ts:568` 的 `client.on("event", …)` **不区分事件类型**，整条 `handleFrame → dispatchEvent` 照走。`inbound.ts:16/56` 把它映射成 `inboundKind:"event"`、正文 `[event:disconnected_event]`；该帧没有 `from.userid`/`chattype`，于是 peer 落成 `direct:unknown`。`dispatcher.ts` 没有按 `inboundKind` 拦截。→ **在连接正在被终止的瞬间，插件启动了一轮完整的 OpenClaw 运行**；等它产出答案，`reply.ts:3753` 的 `else if (isEvent)` 分支还会朝 `peerId="unknown"` 发一条 markdown。
2. `sdk-adapter.ts:315-318` 判断「是否被踢」用的是字符串关键词 `kick` / `owner` / `replaced`——这套关键词来自 v2.3.9（SDK 还没有 `disconnected_event` 的年代）。SDK 1.0.7 的真实 reason **一个都不含** → `recordOperationalIssue({category:"ws-kicked"})` **永不触发**，运维侧看不到真正的原因。

**复现**（探针已跑通，脚本存于本次会话 scratchpad `kick-probe.test.ts`，实现阶段将转为正式用例）：

```
输入：client.emit("event", <disconnected_event 帧>)
      client.emit("disconnected", "New connection established, server disconnected this connection")

PROBE handleEvent calls   = 1                       ← 期望 0
PROBE dispatched event    = {"inboundKind":"event",
                             "text":"[event:disconnected_event]",
                             "peer":{"peerKind":"direct","peerId":"unknown","senderId":"unknown"}}
PROBE operational issues  = []                      ← 期望 ["ws-kicked"]
```

**官方插件怎么做的**（交叉验证，`dist/src/monitor.js:748`）：监听 `event.disconnected_event` → 记错误 → `wsClient.disconnect()` → 清理 → **刻意不重连**，注释写明「reject/resolve 都会触发框架 auto-restart → 新连接建立 → 又被踢 → 两个实例互踢无限循环」。**本插件的修复必须同样不重连**——这一点写进验收标准。

**影响面**：任何时候出现第二个用同一 BotID 的实例（灰度、双开、重启重叠、本地调试连生产 Bot），旧实例都会：跑一轮无意义的 agent（占额度、可能触发工具副作用）+ 对 `unknown` 发一条注定失败的推送 + 运维看不到 `ws-kicked`。

### 3.2 D2 `undici@7.28.0` 高危告警

`npm audit --omit=dev`：`undici 7.0.0 - 7.28.0` 命中 5 条 advisory（1 high），修复版本 **7.29.0** 已发布。本插件在 `src/http.ts` 直接用 `ProxyAgent` + `fetch`，正是这些 advisory 的作用面（retry interceptor 响应错位、Cache-Control 解析、blob body CRLF 注入、cookie 属性注入）。属 7.x 内的 minor 升级。

### 3.3 D3 主动推送未带 `chat_type`

doc 62158（2026-08-12）：`body.chat_type`「1 单聊 / 2 群聊 / **0 或不填则自动兼容（优先按群聊处理，建议明确指定）**」。

- SDK 1.0.7 **完全没有 `chat_type`** 这个字段（全文件 0 次出现），但 `sendMessage(chatid, body)` 是 `{ chatid, ...body }` 透传、`sendReply` 也原样入帧——**多带一个字段就能上线**，只是 TS 类型 `SendMsgBody` 未声明，需要在边界处断言。
- 本插件 `sdk-adapter.ts:246` 的 `sendMarkdown(chatId, content)` 不带；而 `reply.ts:1306` 早就算出了权威的 `peerKind`（`direct`/`group`）。
- 现状是**让服务端先按群聊猜、猜错再兜底**。没有现网失败证据，但这是文档明确建议、且我们手上信息更准的场景。

### 3.4 D4 `wecom_mcp` 只向模型暴露了 4/9 的能力入口

`tool.ts:132` 的参数描述是「MCP 品类，如 contact、todo、meeting、doc」，`README.md:144` 同样写「典型能力品类：doc、meeting、todo、contact」。两处都来自 `2.3.18`（`522d0fa`，2026-03 引入 MCP 层时），上游 `origin/main` 至今一字未改。

后果是**能力被授权了却调不到**：企业在后台授权了邮件 / 微盘 / 日程 / 消息，模型却没有任何线索知道 `wecom_mcp` 能走 `mail` / `disk` / `schedule` / `msg`；而智能表格、智能文档更隐蔽——它们藏在已有的 `doc` 里，模型同样无从得知。

`category` 是自由字符串（无 enum），所以这是**纯描述层缺口**，不是结构缺陷：改描述即可，零运行时风险，且未来官方再加品类也不会把插件写死。

## 4. 可量化目标

### G1（必做）断连事件不得进入 agent 通道，且必须留下诊断

| 项 | 目标值 |
| --- | --- |
| `disconnected_event` 触发的 `handleEvent` 调用数 | **1 → 0** |
| `disconnected_event` 触发的对外发送数 | **保持 0**（今天是 0 只因探针里 agent 被 mock；修复后从结构上为 0） |
| 该场景下 `recordOperationalIssue({category:"ws-kicked"})` | **0 → 1 次**，且 `summary` 含「新连接已建立」语义 |
| 该场景下 transport session | `running:false, connected:false`，`lastError` 非空 |
| **重连次数** | **0**（不得自动重连；防互踢，与官方一致） |
| 其它事件（`enter_chat`、`template_card_event`）行为 | **完全不变**（现有用例全绿即为判据） |
| 产线改动量 | 预计 **≤ 20 行**，集中在 `sdk-adapter.ts` 一处 |
| 新增用例 | ≥ 3 条（进入 agent 通道 = 0 / 诊断落账 / 正常事件不受影响） |
| 敏感性 | 还原生产改动后，新用例**必须立刻转红** |

### G2（必做）`undici` 7.28.0 → 7.29.0

| 项 | 目标值 |
| --- | --- |
| `npm audit --omit=dev` high 数量 | **1 → 0** |
| `package.json` / `package-lock.json` | 精确锁 `7.29.0`（沿用现有精确锁风格） |
| 产线代码改动 | **0 行**（仅依赖） |
| 验证 | `tsc --noEmit` + `build` + `verify-dist` + 全量 612 用例全绿 |

### G3（必做）主动推送显式带 `chat_type`

| 项 | 目标值 |
| --- | --- |
| 作用范围 | **仅 `reply.ts` 推送通道**（`peerKind` 权威）；`outbound.ts` 的 Agent 主动发消息**不动**（那里拿不到可靠的会话类型） |
| 上线帧 | 单聊 `chat_type:1`、群聊 `chat_type:2`，其余字段不变 |
| 产线改动量 | 预计 **≤ 12 行**（`BotWsPushHandle.sendMarkdown` 增一个可选参数 + adapter 内一处断言） |
| 新增用例 | ≥ 2 条（单聊/群聊各一，断言上线 body 里的 `chat_type`） |
| 真机验证 | 上线前必须在真机各发一条单聊推送与群聊推送，确认**送达且未串会话** |
| 回滚 | 单独一个 commit，出问题直接 revert，不牵连 G1/G2 |

**实现路径**（四处改三处）：

| 位置 | 改动 |
| --- | --- |
| `src/app/index.ts:15` | `sendMarkdown: (chatId, content, chatType?: "direct" \| "group") => Promise<void>`，参数**可选** |
| `sdk-adapter.ts:246` | `chatType` 存在时映射 `chat_type: chatType === "group" ? 2 : 1`；不存在则**一个字段都不加** |
| `reply.ts` 四处 | 传入/带上 `peerKind`（`reply.ts:1306` 已算好，源自入站帧 `chattype`，权威值）：push handle 路径、`sendViaClient` 回落、事件回复的正常与错误分支 |
| `outbound.ts:398` | **不动**——那条路径只有 `to`，拿不到可靠会话类型，猜不如不猜；参数可选正是为了让它逐字节不变 |

SDK 无需等新版本：`sendMessage(chatid, body)` 内部 `{ chatid, ...body }`、`sendReply` 原样入帧（两处源码已确认），多带字段即可上线；`SendMsgBody` 未声明该字段，**只在这一个调用点断言**，不全局放宽类型。

### G4（收尾）文档与红线

- `SESSION_HANDOFF.md` 新增一条事件档案（上游核查结论 + D1 根因），并把「**收到 `disconnected_event` 后禁止自动重连**」「**事件帧不得无差别进入 agent 通道**」写进禁改清单。
- `changelog/v2.7.260-12.md` + `changelog/README.md` + `README.md` + 版本号。
- 打包/打 tag/推送**仍需你单独同意**，顺序沿用 `2.7.260-11` 定下的约定（先文档、后 tag、最后打包）。

### 全局验收（沿用现有验证链）

`46 文件 / 612 测试` → **≥ 618 全绿**；`npx tsc --noEmit`、`npm run build`、`npm run verify-dist`、B1/B2/B3、`git diff --check` 全过；仅用与生产一致的 OpenClaw `2026.7.1-2`。

---

## 5. 本轮明确不做（及理由）

| 不做 | 理由 |
| --- | --- |
| **升级 `@wecom/aibot-node-sdk`** | 没有新版本可升，1.0.7 已是 latest |
| **补 `feedback_event` 处理** | 本插件从不设置 `feedback.id`，按官方文档该事件**不可能被触发**。为不可能发生的场景加处理违反仓库反过度工程约定。若将来接反馈按钮，再一并处理 |
| **在 `wecom_doc` 里接入「管理智能文档内容」16 个新接口（smartpage）** | ①纯功能扩展（约 +1500 行量级），与本轮「稳定性/速度 + 最小改动」正交；②Bot WS 平面走 `biz_type: doc` 已能触达 `smartpage_*`（见 §8.1），只剩 Agent 平面没有，性价比进一步下降。doc_id 已记在 §2.5，随时可单独立项 |
| **切到官方 wecom-cli / 官方插件路线** | 等同重写，且会丢掉本 fork 已验收的 B1/B2/B3 与 11 轮长任务/流式修复 |
| **把 `BLOCK_PREVIEW_MAX_MS` 往官方的 10 分钟放** | 官方 10 分钟是 API 上限；现值 5 分钟是被真机 846605/846608 逼出来的。没有真机证据前放大 = 拿稳定性赌 |
| **清理 `disconnected` 里的 `kick/owner/replaced` 关键词** | 无法证明它对 WS close reason 也是死代码，本轮不动无关行为 |
| **为「7 天授权过期」加缓存 TTL 或 401/403 重取** | 官方写的是「到期需**重新授权**」——授权要人去后台点，重取 URL 治不好，加 TTL 只是每小时多打一次无用的 `aibot_get_mcp_config`。且我们并不知道过期的真实错误形态，按猜到的状态码写分支属于为不确定场景加防御。转入 §8 专项，在文档里写清这条运维约束 |
| **`fast-xml-parser` 5.10.1 → 5.11.0** | 无告警、无功能需求，纯 minor，不在本轮范围 |

---

## 6. 风险与回滚

| 风险 | 评估 | 处置 |
| --- | --- | --- |
| G1 误伤正常事件 | `enter_chat` / `template_card_event` 均有现存用例覆盖 | 只按 `eventtype === "disconnected_event"` 精确匹配，不做白名单式收敛 |
| G1 改成「不重连」后，被踢的实例永久离线 | **这是期望行为**，与官方一致；重连只会互踢 | 通过 `ws-kicked` 诊断 + session `running:false` 让运维可见 |
| G2 undici minor 引入行为变化 | 7.x 内 minor，用法仅 `ProxyAgent`/`fetch`/`Dispatcher` 类型 | 全量测试 + build + verify-dist；异常则回退 7.28.0 并记录 |
| G3 `chat_type` 判断错 → 推送串会话 | `peerKind` 来自入站帧的 `chattype`，是权威值 | 单独 commit + 真机双向验证；异常直接 revert |
| G3 判断不了会话类型的路径被误改 | `outbound.ts` 明确不动，参数可选 | 用例断言该路径不含 `chat_type` 键 |
| 三项互相牵连 | — | 三个独立 commit，可单独 revert |

---

## 7. 本轮执行顺序（已批准）

1. **G1**：探针转正式失败用例（红）→ 改 → 转绿 → 敏感性还原验证。
2. **G2**：升依赖 → 全链验证。
3. **G3**：改 → 用例 → 记入真机验证清单。
4. 多维走查 / 代码审核 / 模拟测试 → 修完发现的问题。
5. 更新文档与版本号 → 打 tag → 推 **fork**（`origin` 只读，绝不推）→ **最后**打包。

---

## 8. 下一轮专项：`wecom_mcp` 评估与升级

> 触发原因：**用户已在实际使用中遇到问题**。因此下一轮**不从改代码开始，先定位现象**。

本轮核查中已经形成、但留给专项落地的结论：

### 8.1 已确认的事实（可直接用）

官方 CLI 概述（doc 61944，2026-08-14）给出了 `biz_type` 的**完整取值表**，与本插件 4 个既有经验值 **4/4 吻合**：

| 能力 | `biz_type` | 工具前缀 |
| --- | --- | --- |
| 消息 | `msg` | `message_*` |
| 邮件 | `mail` | `mail_*` |
| 文档 / 表格 / 智能表格 / 智能文档 | `doc`（四合一） | `doc_*` / `sheet_*` / `smartsheet_*` / `smartpage_*` |
| 待办 | `todo` | `todo_*` |
| 日程 | `schedule` | `calendar_*` |
| 会议 | `meeting` | `meeting_*` |
| 微盘 | `disk` | `disk_*` |
| 通讯录 | `contact` | `contact_*` |
| 素材 | `media` | `media_*` |

按工具前缀推断会在 4 处推错（`msg`/`schedule`/以及表格三项并非独立品类），**必须以这张表为准**。

### 8.2 待办事项（专项内逐条评估）

1. **先复现用户遇到的问题**——没有现象就不动代码。
2. 描述层：可用 `biz_type` 4 → 9，并点明 `doc` 覆盖表格/智能表格/智能文档；**不引入 enum**（官方再加品类不能把插件写死）；描述 ≤350 字符（每轮进上下文，不能拖慢响应）。
3. `tools/list` 返回体**无上限**：按官方表 `doc` 一个品类约 **62 个工具**（13+10+28+11），`handleList` 把每个工具的完整 `inputSchema` 全量 `JSON.stringify(…, null, 2)` 返回。旁证：官方插件自己把这批参数说明拆成 `references/*.md` 按需读（smartsheet 154KB、smartpage 67KB）。方案候选：`method` 前缀过滤 + 超阈值降级为紧凑索引（小品类逐字节不变）。**先在真机量一次 `doc` 的返回字节数再定。**
4. 运维约束：**文档权限有效期 7 天，到期需成员重新授权**——写进文档，不加 TTL/401 重取（重取治不好需要人工授权的过期）。

### 8.3 本轮已证伪、专项不必再查

- **配置拉取会不会卡住流式回执**：不会。SDK 的 `replyQueues` / `pendingAcks` 均以 `req_id` 为键，`mcp_config` 与流式回复不同队不同 ack 槽（源码确认）。
- **`protocolVersion: "2025-03-26"` 是否要升**：今天跑得通，无任何证据支持升级，改它是拿在跑的东西赌。
