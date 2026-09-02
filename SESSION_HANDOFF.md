# SESSION HANDOFF - OpenClaw WeCom 插件维护

> 最后更新：2026-08-29
>
> 本文件只保留当前可执行信息。早期版本流水账、已经关闭的排查过程和旧测试数字不再重复；需要历史细节时查看 git log 与 changelog。

## 0. 先读结论

- 已发布基线：2.7.260-26，标签 released/2.7.260-26，已推送 fork。
- 兼容目标：OpenClaw 2026.7.1-2（用户生产）与**最新稳定版**（发版时为 2026.8.2）。devDependency 仍钉 2026.7.1-2；`npm run compat:check` 对两条线各跑 typecheck 与全量测试，**发版前必跑**。2026.6.x 不再维护。
- 2.7.260-26 收口四件事（详见 changelog/v2.7.260-26.md）：
  - **长任务结尾的假状态**有两条独立机制：推送车道把时钟押在答案正文上（现场 12m24s 是死亡时刻 + N×60s 网格的指纹）；一次 ACK 丢失后 final 改走推送而冻结气泡永不 finish。前者改为带正文的推送不缀钟，后者在答案推送落地后补一帧去钟的 best-effort finish。收尾推送只发「（回复完毕）」。
  - **8.x 兼容**：根入口与约 55 个子路径被删、`loadConfig` 删除、`assertLocalMediaAllowed` 私有化、`useAccessGroups` 删除、`agents.entries` 成为名册正典（`agents.list` 只是只读投影）、真实分发器要求 SQLite 迁移——全部改成两条线共有的接口。8.x 上操作侧必须放行 `plugins.entries.wecom.hooks.allowConversationAccess=true`（向导已自动写入；7.x 该钩子不受此闩）。
  - **Bot WS 提速**：死窗后正文按 20 秒推送；气泡帧与冻结阈值从 3500/3000 抬到 5000 字（B2 门禁字面量同步改，属有意识的决定）。
  - **Agent API 车道**：移植上游字节切分与 1100ms 节流；不影响 Bot WS。
- 2.7.260-25 收口两处真机反馈：
  - **同一份答案发两遍，并漏出本地路径**。根因在 OpenClaw 核心：block 走 `createBlockReplyDeliveryHandler` 的 `extractMediaDirectives: false`（`MEDIA:` 原样保留），final 走 `splitMediaFromOutput`（剥指令**且把所有空行压掉**）。插件按字节比对判成两段不同文字后拼接。修两层：摄入边界剥指令（`stripMediaDirectives`），比对处改用核心那三条替换本身（`respaceLikeCore`）。**第二层是根治**——复刻上游解析器必输，只要还依赖字节相等，任何规则猜错都等于重发整份答案。
  - **「长任务处理中，请勿打断」早了三分钟**。流窗口早死时 gate override 把推送车道首格拉到 5 分钟，而该车道把措辞写死不看时钟。现让 `formatElapsedStatus` 按 `elapsedMs` 自选前缀，取消所有调用点跟 8 分钟阈值唱反调的能力。现场描述的「2 分钟」版本未复现且可证明出不来（下一格恒 ≥ 开始 + 5 分钟）。
- 2.7.260-23 修一处真机反馈：**企微流窗口关闭后，模型产出的东西全部被丢弃**。推送车道原本写死「Reasoning stays out」——气泡活着时是分工，气泡一死（约 6 分钟）就成了丢弃，只思考不出正文的回合从此完全静音。现让推送车道携带思考窗口。探针复现见 changelog；先复现再改，改完同一探针验证。
- 2.7.260-22 收口两处真机反馈：
  - **长任务超时只报「LLM request failed.」**：OpenClaw embedded run 命中自身 600 秒上限（agents.defaults.timeoutSeconds）后连发两条 final，第二条点名了该配置项，却被 markFinalDelivered 当作重复投递丢弃（日志 `[wecom-b3] final-skip second-distinct`）。现改为：已投递的是错误通知时放行后续 final，已投递的是正常答案时行为不变。
  - 卡片点选提交后，agent 只收到 `[event:template_card_event]` 占位串，只能回一句「已收到某某事件」，提问的人拿不到选择结果。现把回调渲染成含卡片标题与选项原文的可读文本（`describeTemplateCardEvent`），并用发卡缓存把 option_id 还原成用户看到的文字。
- 2.7.260-21 有两块内容：
  - **对抗式评审**：上一轮候选声称修好两个问题，逐条复现后两个都没修好，第二个还引入内容丢失；三项均已修复（详见第 2.0 节）。
  - **官方功能对齐**：补齐模板卡片出站能力、deferred 回合不再宣称完成、入站附件超限给出可操作提示。
- 当前验证结果：全量 58 个测试文件、768/768 通过（74s）；typecheck、build、dist、B1、B2、B3、diff check 全部通过。
- goal.md 已删除：待办清单全部完成，仍然开放的缺口与明确不做的两项都并入本文件第 5 节，官方对账结论并入第 8 节。

## 1. Git 与发布边界

### 当前 Git 状态

- 分支：main
- HEAD：released/2.7.260-26 所指提交（其前三个功能提交 a9b1882 / f53c974 / 821f413），与 fork/main 相同
- 维护远端：fork = git@github.com:liny90626/wecom.git
- 上游远端：origin = https://github.com/YanHaidao/wecom.git（已对账其 25 个新提交，见第 8 节）
- 允许推送的目标只有 fork；禁止向 origin 推送。
- 2.7.260-26 涉及的文件：
  - src/transport/bot-ws/reply.ts / reply.test.ts / gateway-sim.test.ts / long-task-progress.test.ts / media.ts / media.test.ts
  - src/app/index.ts、src/runtime.ts（getWecomRuntimeConfig）、src/dynamic-agent.ts（+ dynamic-agent.roster.test.ts 新增）、src/shared/command-auth.ts、src/onboarding.ts / onboarding.test.ts
  - src/shared/byte-chunking.ts、src/shared/send-pacing.ts（+ 测试，上游原文）、src/types/constants.ts、src/monitor/limits.ts、Agent 车道四个发送点、src/outbound.ts
  - 53 个文件只改 openclaw import 路径；src/openclaw-sdk-imports.test.ts（新增守卫）
  - scripts/check-openclaw-compat.mjs（新增）、scripts/patch-wecom-long-message.mjs（门禁字面量 3_000 → 5_000）
  - src/runtime/reply-orchestrator.test.ts（独立临时状态目录、8.x 兜底契约）、mcp 两个测试的 runtime 替身
  - package.json、src/version.ts、.gitignore、README.md、changelog/、本文件

### 发布状态

- 版本号 2.7.260-26，包指纹见第 7 节。
- tag released/2.7.260-26 与 main 均已推送 fork，核对结果见第 7 节。
- origin 仍停在 f5f5650，无本仓库的 tag；始终只读，从未推送。

## 2. 当前候选改动

### 2.-4 长任务收尾、双版本兼容、Bot WS 提速（2.7.260-26）

收尾假状态两条机制的复现用例：`long-task-progress.test.ts`「死窗后的收尾…」、`gateway-sim.test.ts`「closes an ACK-untrusted bubble…」与「finishes an externally answered bubble…」。三条不变量：
- 带正文的推送不缀时钟；只带步骤 / 思考 / 什么都没带的推送照旧（`maybeSendPreviewExpiredNotice` 里 `undeliveredProgress ? "" : formatElapsedStatus(elapsedMs)`）。
- 任何 finish 帧都经 `stripElapsedStatusLine`；`closeUntrustedBubbleAfterPush` 只在 `deliverNormalFinalViaStream` 的两个「活着但不可信」分支、推送成功之后调用，从不用于 terminal-fallback 分支（final 帧可能已落地）。迟到 ACK 确认在 settle 后也刷新 `lastPreviewText`（评审发现的正文丢失窗口）。
- `resolveStreamFallbackText` 余量为空且非错误时只返回 `FINAL_COMPLETION_MARKER`。

双版本兼容的规则：**不探测版本、不分叉**，每个 openclaw import 必须在两条线的导出表里都存在，`src/openclaw-sdk-imports.test.ts` 维护允许列表；新增子路径前用 `npm view openclaw@<version> exports` 两边核对。`infra-runtime` 仅为 `resolvePreferredOpenClawTmpDir` 保留（8.x 的 focused 家在 file-access-runtime，7.1-2 没有）。8.2 的 `file-access-runtime` 不带 .d.ts，compat 脚本用 shim；`agents.list` 在 8.x 是非枚举只读投影，名册探测用属性访问而不是 structuredClone。8.x 上 `runEmbeddedAgent` 直接调用需要网关准备的执行上下文，探针改用 `openclaw plugins inspect wecom --runtime --json`（临时 OPENCLAW_STATE_DIR）。

提速两项：死窗后带正文的推送用 `PUSH_BODY_MIN_INTERVAL_MS`（20 s）自己的节奏，仍在 `longTaskStatusGateAt()` 之后；死窗上新到的 block 直接唤醒推送车道。气泡帧 `WECOM_STREAM_PREVIEW_MAX_CHARS` 与冻结阈值 `BLOCK_PREVIEW_MAX_CHARS` 都是 5000（final 帧早已 5000/15360）；推送分片 `WECOM_STREAM_MAX_CHARS` 仍 3500，因为主动推送 15 KB 上限没有现网证据。**没有做滑动尾巴**：窗口一死气泡就是永久记录，滑过去的正文要么整段重发要么按前缀书签丢失。

已知但未改：正文预览 5 分钟冻结后不再向企微发帧，死窗只能由步骤帧、工具阶段 90 秒心跳或 8 分钟状态帧撞出来；纯正文、无工具的回合会等到 8 分钟。可选修法是冻结后每 20 秒发一帧同内容探测帧。

### 2.-3 媒体指令导致的整份重复与措辞阈值（2.7.260-25）

**重复内容。** OpenClaw 核心把同一个答案用两种形状交给插件：

- block 走 createBlockReplyDeliveryHandler → normalizeReplyPayloadDirectives，写死 `extractMediaDirectives: false`，
  所以 `MEDIA:<path>` 原样留在块文本里；
- final 走 splitMediaFromOutput，剥掉指令之后还执行
  `.replace(/[ \t]+\n/g,"\n").replace(/[ \t]{2,}/g," ").replace(/\n{2,}/g,"\n").trim()`——**所有空行被压掉**。

插件按字节比对判成两段不同文字，拼接：整份答案发两遍，中间还漏一条本地路径给用户看。

修复两层，第二层才是根治：

1. 摄入边界 `stripMediaDirectives`（在 `const text = ...` 处对每个 payload 生效），镜像核心规则：
   围栏用**真实**状态机（同字符、长度不短于开围栏、其后只有空白才闭合；布尔量切换会在 ```js … ~~~ … ``` 上错位）；
   逐 token 只认 https URL 与路径，**裸文件名不在此列**（核心只在整段 payload 上才用裸文件名规则，
   这正是 `MEDIA: 设计稿 v2.png` 仍能成为附件的原因）；一行里指令旁边的字保留；
   恰好一个 token 命中且整段读起来是一条路径时整行让位。
2. 比对处 `mergeReplyText` 在字节判定失败后，用 `respaceLikeCore`（核心那三条替换本身）再比一次。

**不要**改用「抹掉所有空白」来比：那会把「先错误缩进、再正确缩进」的两段代码判成同一段而丢掉后者。
**不要**在这两条新分支上用 `normalizeDedupText`：它连标点与大小写都抹平，`内存 15GB` 会盖掉修正后的 `内存 1.5GB`。

**书签不变式（改这里必看）**：final 是块的超集时，拼接结果必须是「保留已发出的字节 + 只追加新增尾巴」
（`offsetAfterSqueezedPrefix` 按非空白字符计数定位切点）。整体换成 final 的排版会让
lastDeliveredBodySourceText / previewFrozenDeliveredSourceText 全部失效，死流后的补发会重发用户看过的内容。

**措辞阈值。** 流窗口早死时 longTaskStatusGateOverrideAt 把推送车道首格拉到 5 分钟，
而该车道原本把「长任务处理中，请勿打断」写死、不看时钟（实测 t=300s 即出现）。
现让 formatElapsedStatus 按 elapsedMs 自选前缀——不是修一个调用点，是取消所有调用点跟阈值唱反调的能力。
五条 gateway-sim 用例的期望值随之改为轻量措辞并追加 not.toContain(LONG_TASK_STATUS_PREFIX)，断言比原来强；
一条 8m00s 的用例不变（走回执不可信路径、无 gate override）。

### 2.-2 流窗口关闭后的思考块传递（2.7.260-23）

企微流窗口约 6 分钟关闭后，气泡再也刷不动，唯一通道是主动推送（sendMessage 发新消息）。
推送车道原本明确排除 reasoning（注释：Reasoning stays out — only the visible body travels this way）。
那条规则在气泡活着时成立，气泡一死就等于丢弃：一个只思考、不产出正文的回合完全静音。

修复：
- sendMarkdownChunksViaActivePush 新增可选 thinkingBlock，**分片前先从预算里扣掉占位**，再拼到第 0 片前面。
- 必须拼在 wire 文本之外：chunkWeComMarkdownWireV2 会把 <think> 转义成 &lt;think&gt;，
  那对模型输出是对的（防止模型写字面 <think> 撑爆客户端），对我们自己合成的块是错的。
  与 final 走流时 prependThinkingWithinFrameBudget 的做法一致。
- maybeSendPreviewExpiredNotice 用「正文在场时」那份限幅（800 字符 / 2400 字节）算思考窗口，
  计入 hasNewContent，书签 pushedThinkingText 只在确认推送成功后推进（与 pushedFastModeText 同构）。

节奏：正在思考时每分钟一条；推理不动时 undeliveredThinking 为空，自动退回 5 分钟静默节奏。
三条 gateway-sim 用例的期望值随之变化（两条改为 toContain + 断言思考块在场，一条时间点 8:00/13:00 → 5:00/10:00），
不是放宽——禁改 34 的 8 分钟绝对阈值管的是无内容的纯时钟推送，未被触动。

### 2.-1 模板卡片出站能力（2.7.260-21 新增）

此前 wecom-send-template-card 技能随包发布，但本 fork 没有任何出站卡片实现——模型照技能吐出的 JSON 代码块会被当普通 markdown 发给用户。按官方 2026.8.17 移植补齐。

- src/capability/card/parser.ts：抽取、字段类型修正、必填补全、简化格式转 API 格式、task_id 重新生成、流式遮罩。解析失败或 card_type 不合法的代码块保留在正文里（那多半是模型贴给用户看的普通 JSON）。
- src/capability/card/manager.ts：进程内缓存（TTL 24h / 上限 300）、按 chat_type 主动推送、template_card_event 回调更新。
- 接入点三处：reply.ts 的 renderPreviewFrame（遮罩，放这一层是为了三条预览车道行为一致）、reply.ts final 路径（抽取并推送，正文只留剩余文字）、sdk-adapter.ts 的事件分发（先更新卡片再照常派发给 agent）。
- 与官方有意保留的四处差异（日志不打卡片 JSON、发送失败要告诉用户、核心字段缺失跳过不发、群聊带 chat_type）见 changelog。

### 2.0 对抗式评审：上一轮候选的三处问题（本版修复）

上一轮候选写的两条修复，复现后判定如下。所有结论都有实测数据，不是读码推断。

1. **冻结状态定时器仍会空转。** 候选给 startPreviewStatusInterval 加了五个守卫，漏掉“流仍可写、ACK 一直不回”（streamAckUnreliable 锁死而 streamUpdateUnreliable 仍为 false）。实测 200 次 timer 步进出现 98 个 0ms 定时器，只推进 79.6 秒虚拟时间，replyStream 调用 297 次（约 3.7 次/虚拟秒，设计是 60 秒 1 帧）。
   根因是车道语义不一致：本车道的状态槽只在**确认送达**时消费，而 sendPlaceholder 与 maybeSendPreviewExpiredNotice 都是**派发即消费**；一帧未确认 → 槽位仍到期 → 重挂算出 0ms → 立即重进。
   修复：startPreviewStatusInterval 增加 minDelayMs，“跑完一轮之后”的两个重挂点传 LONG_TASK_STATUS_INTERVAL_MS，冻结时首次挂载仍传 0。修复后 0 个 0ms 定时器，200 步覆盖 2.6 小时虚拟时间。
   注意：先试过“派发即占用槽位”的对齐写法，它会把死流场景下推送车道的接管推迟整整一分钟（8:00 静默到 9:00），5 条既有用例变红，已放弃，不要再走这条路。

2. **closeDeferred 不再关闭企微流。** 探针对比：基线发 replyStream(<用户已看到的文本>, finish=true)，候选什么都不发。仓库其余所有终态路径都会发 finish=true；不收尾的流会让气泡在整个窗口期（约 6 分钟）保持“正在生成”。
   修复：closeDeferred 改走既有 closeOpenedStreamSilently(lastPreviewText)，编排层补 await sealProgress()。

3. **closeDeferred 静默丢正文。** 探针对比：两段 block、第一段送达后窗口关闭，基线推送“继续输出：\n\n第二段未送达的尾巴。”，候选推送为空。这比它要修的问题更严重，也违反“宁可有限重复，不静默丢答案”。
   真实边界：那句“最终回复已完成，以上预览内容即为完整回复。”只在 remainder 为空时由 resolveStreamFallbackText 产生。
   修复：closeDeferred 返回 boolean，回合仍有未送达正文时返回 false，编排层落回既有 final 通道（分片/重试/书签/去重都在那里，不重写）。

候选原有的两条 deferred 用例去掉生产改动后照样通过、不具判别力，已改写为断言收尾帧 finish=true 且不含完成文案。新增两条回归均经反向验证。

### 2.1 长任务后段定时器空转

#### 用户现象

- 短任务基本正常，长任务运行到约 8 到 10 分钟后更容易出现 LLM request failed、LLM request timed out 或回复不完整。
- 企微流式气泡在长任务后段停止更新，最后的状态或答案可能改走另一条消息。
- 旧实现会在状态帧失败后持续占用进程，表现为卡顿、无后续反馈或测试无法推进时间。

#### 已确认的根因

1. WeCom SDK 对同一个 req_id 只维护一个串行 ACK 槽；流式窗口约在 6 分钟后失效，插件 callback claim 约在 8 分钟后到期。
2. 旧插件在冻结状态定时器触发后，没有等待当前异步发送结算就立即安排下一次刷新。
3. 当发送被 replyStreamNonBlocking 跳过、ACK 尚未返回、或 callback 所有权已失效时，下一次到期时间已经落后于当前时间。
4. 插件因此反复创建 setTimeout(..., 0)，形成事件循环空转，可能延迟 OpenClaw 的 CLI 输出解析、I/O 或 watchdog 处理。
5. OpenClaw 最后把底层异常统一显示为 LLM request failed.；该文案不是插件生成的，也不能单独证明模型先失败。

#### 修复

见 src/transport/bot-ws/reply.ts 的 startPreviewStatusInterval：

- 状态定时器只在当前发送 Promise 完成后重排；
- ACK 在途、pending preview、状态发送中、流已失效或回合已被接管时禁止重新挂载；
- 流窗口确认失效后停止旧流定时器，由主动推送继续报告状态；
- 不改变成熟的 final 分片、重试和去重策略。

#### 证据

- 临时移除新守卫后，8 分钟到 13 分钟场景重新卡死并触发 30 秒测试超时；恢复后正常收到 8 分钟和 13 分钟推送。
- 已覆盖 ACK 在途、supersede、callback claim 到期三种竞态。
- 相关测试：
  - src/transport/bot-ws/reply.test.ts 中的 ACK 在途和 supersede 用例；
  - src/transport/bot-ws/gateway-sim.test.ts 的长任务状态用例。

### 2.2 deferred 回合的伪完成

#### 用户现象

过程气泡已经显示，但 OpenClaw 暂时没有 final 时，旧逻辑会再发一条“以上预览内容即为完整回复”，用户误以为过程就是答案。

#### 修复

见 src/runtime/reply-orchestrator.ts 的 deferred 分诊：

- ReplyHandle 增加 closeDeferred；
- deferred 回合只关闭本地临时流，不发送伪造完成文案；
- 后续真实 final 仍可通过同一 handle 投递；
- markRunActivity 和 closeDeferred 已透传到 runtime wrapper。

相关回归覆盖普通正文预览、preamble 预览和 message_tool_only。

## 3. 用户补充问题逐项状态

| 问题 | 状态 | 交接判断 |
| --- | --- | --- |
| 过程气泡同一句重复 | 已修复已复现类型 | 相邻同文 preamble 会合并，重复的工具标签不再展示。非相邻且确实由模型重复生成的句子仍保留，避免误删业务内容。 |
| Tool Call / Exec 过程噪音 | 已修复 | 工具生命周期只作为“任务仍在运行”的事实，不再把命令、路径、参数或工具标签发给用户。 |
| 过程内容最终被清理 | 设计明确 | 过程是临时进度，final 到达后只保留答案；按用户要求不放入思考块。 |
| 过程气泡后最终答案不完整 | 核心投递路径已修复 | 流过期、ACK 延迟、主动推送和 final 分片重试均有回归；若 OpenClaw 根本没有生成 final，插件不能凭空恢复。 |
| 长任务无提示、工具阶段假死 | 已修复核心路径 | 使用时间驱动心跳、工具阶段沉默检测和流过期后的主动推送。 |
| LLM request failed / timed out | 插件触发器已修复，不能承诺所有上游错误消失 | OpenClaw 自身 CLI watchdog 仍独立存在；发生新案例时必须用 reqId 对齐原始日志。 |
| 重复 Compacting context / 压缩失败 | 未在插件中修复 | 已在不加载 WeCom 插件的纯 OpenClaw 环境复现，是 OpenClaw 上下文压缩行为；建议 reserveTokensFloor >= 50000，必要时启用更早的 precheck。 |
| Windows archive changed during validation | 原因已定位，未做代码修复 | 更像映射盘、NAS 或同步盘的文件身份变化，不等于包损坏。复制到本地 NTFS、校验 SHA-256，再用 npm-pack:<local-package-path> 安装。 |

## 4. 已关闭且不要重新打开的稳定语义

- 过程边界：同一 item 更新原位替换；相邻新 item 同文视为同一句被 flush 边界切开的自述；前缀延续合并；非相邻真实重复保留。
- 过程日志：工具回合按步骤追加显示；流死亡后由 durable 前缀书签增量推送；只有确认送达才推进书签。
- 思考块：必须做 wire 安全化；只显示最新窗口；正文在场时让位；不能因为思考块截断而吞掉答案或切断 emoji 代理对。
- 流过期：846605 或 846608 表示旧流不可再写，转主动推送；单次 ACK 缺失不等于已证明未送达。
- 回调所有权：req_id 不是天然唯一；使用 messageId + ownerToken + TTL，冲突、缺失、过期或 pending ACK 时 fail closed。
- final 可靠性：只能从未确认分片续传；已确认的可见旧 final 被新消息接管后按既有 B3 语义不再复活。
- 入站合并：同一发送者的相邻文字和媒体可以合并；附件是输入，不能因前一回合已经开始回复就丢掉；不同成员内容不能跨人合并。
- 生命周期：supersede 或 transport stop 才会中止对应 OpenClaw run；普通流 ACK 或窗口失效不会主动 abort 模型 run。

## 5. 当前仍开放的边界与风险

这些不是本轮声称已解决的内容：

1. 群聊中不同成员接管任务时，旧回合提示仍偏向“合并思考”，文案没有完全区分跨成员场景。
2. 流仍健康但预览已冻结（5 分钟或 5000 字）时，冻结之后的新正文要等到 final 才显示，这是刻意的：气泡活着时 final 会整帧替换它，提前推送余量只会在 final 到达时重复。死窗后的余量自 2.7.260-26 起按 20 秒推送；但冻结后正文块不再发帧，死窗要靠步骤帧 / 90 秒工具心跳 / 8 分钟状态帧撞出来（见 2.-4）。
3. 回合前 120 秒内流就失效且此前没有成功预览时，后台通知存在窄场景被取消的可能。
4. ambiguous 主动推送重试仍有有限重复风险，当前上限为 3 次；这是“宁可有限重复，不静默丢答案”的明确取舍。
5. 真实 Windows、企业微信网关和客户端仍未全面验收；网关模拟器不能代替真机验证。模板卡片的**渲染与点选后就地更新已由使用者在真机确认通过**（2.7.260-21）；2.7.260-22 修的回调文本仍需真机复验——点选后应看到 agent 基于实际选择的回复，而不是「已收到 … 事件」。测试步骤见第 9 节。Windows 侧还缺 CLI 子进程 spawn、插件私有 node_modules 里 @wecom/cli-win32-x64 的 require.resolve、WECOM_CLI_CONFIG_DIR 的 0700 可写性；官方没有 win32-arm64 平台包，目标机若是 ARM 则整条 CLI 链路不可用。
5.4 2.7.260-25 的一个**刻意取舍**：两段文字只差空白时，已经发出去的那份字节胜出。
    好处是所有投递书签保持有效，推送车道不会重发用户看过的内容；代价是模型「先给错误缩进、
    再给正确缩进」的同一段代码，气泡里留的是前一份。属产品取舍而非技术限制，可以反过来。
5.5 2.7.260-25 需真机复验两点：①带附件的长报告只出现一次、且不含 `MEDIA:` 本地路径；
    ②8 分钟以内不再出现「长任务处理中，请勿打断」。若仍见到后者，需要 `[wecom-preview] expired-notice … elapsedMs=` 日志行——
    现场描述的「2 分钟」版本本轮未能复现，且静态可证下一格恒 ≥ 开始 + 5 分钟。
5.6 2.7.260-26 需真机复验：①长任务答案末尾不再有时钟；②答案改走推送时上方气泡应已关闭且不带时钟（日志 `stream-final-skip-unreliable` 新增 `ackUntrusted` / `windowDead` 字段区分两种收尾）；③气泡帧最大从约 10 KB 变为最多 15 KB、每 1.5 秒一帧，看长答案流式是否顺畅；④死窗后长任务后段消息条数会变多（每 20 秒最多一条正文推送）。
5.7 8.x 行为差异（未改代码）：零可见输出的回合，8.x 核心自己投递英文兜底「No reply was generated for this message…」并报告 `noVisibleReplyFallbackDelivered`，7.x 由插件发中文提示；插件对两种形态都处理正确，措辞不同。已安装实例升到 8.x 必须手动补 `plugins.entries.wecom.hooks.allowConversationAccess=true`（向导只在安装时写）。
5.1 仓库 package-lock.json 为 0 字节，npm audit --omit=dev 返回 ENOLOCK。生成 lockfile 会改变安装解析，属于会影响使用者的动作，需用户点头，至今未生成。
5.3 补发改走 wecom-cli 已评估并**否掉**：CLI 的 chat_id 必须取自本次 sessions list（技能明文禁止历史 chat_id），
    只能发给授权人与最近 10 个会话（长任务的目标会话可能已掉出窗口），子进程时延 300~500ms 且按 botId 全局串行，
    等于让「最后一条通道」比主路更脆。唯一可能有价值的位置是「WS 彻底不可用」时的末端兜底——今天两条推送路径共用
    同一条 WS，都断则答案丢失；但需要先有现网 active-push-failed 证据与真机确认 message aibot send 的发送身份，
    未验证前不写代码。
5.2 入站视频首帧提取（ffmpeg）是**明确不做**，不是遗漏：官方 src/webhook/video-frame.ts 只在它自己的 webhook 链路，官方 Bot WS 主链路同样没有；引入 ffmpeg 是装了才生效、没装静默失效的硬外部依赖，收益在本 fork 主链路上是推测性的。要做请单独立项。
6. 当前测试无法单独证明某个生产 LLM request failed 的原始 provider 或 network 错误。复现时要同时保存：
   - 插件日志中的 [wecom-reply] error-final 与 reqId；
   - OpenClaw 的 embedded run agent end 与 rawError；
   - 是否出现 callback-stream-disabled、update-ack-missing 或 status-watchdog-stopped。
7. OpenClaw CLI watchdog 是独立配置项。当前 2026.7.1-2 的 fresh 默认上限为 600 秒，resume 默认上限为 180 秒；不要把它与插件的 WeCom 流窗口混为一谈。需要允许更长无输出阶段时，在 OpenClaw 配置中单独调整 agents.defaults.cliBackends.<runtime>.reliability.watchdog。

## 6. 架构与排查入口

### Bot WS 主链路

src/transport/bot-ws/sdk-adapter.ts
→ src/runtime/dispatcher.ts
→ src/runtime/reply-orchestrator.ts
→ src/transport/bot-ws/reply.ts
→ WeCom SDK replyStream / replyStreamNonBlocking / sendMessage

- sdk-adapter.ts：WS 生命周期、req_id owner claim、入站帧和主动推送 handle。
- dispatcher.ts：pending 入站、同 peer 接管、OpenClaw run 的 abort/drain 和生命周期 barrier。
- reply-orchestrator.ts：OpenClaw 回调、过程排队、deferred/final 分诊。
- reply.ts：气泡、ACK 槽、流过期接管、分片、书签、重试和最终投递。

### 关键时序常量

- WeCom stream frame 预算：15360 bytes；气泡帧与 final 单段上限均为 5000 字符；主动推送分片 3500 字符。
- 流式过程预览冻结阈值：约 5 分钟或 5000 字符（B2 门禁字面匹配该值）。
- 长任务状态首格：回合开始后 8 分钟；正常状态网格每 60 秒；死窗后带正文的推送自己按 20 秒节奏，不缀时钟。
- 状态措辞由时钟决定，不由调用点决定：< 8 分钟一律「【处理中，已用时X】」，≥ 8 分钟才是「【长任务处理中，请勿打断，已用时X】」。死流会把推送首格拉到 5 分钟，但措辞不跟着提前。
- 工具阶段沉默心跳：90 秒；无新内容的后台状态推送静默 5 分钟。
- 本地单次 WeCom 发送超时：8 秒；pending ACK 宽限约 5.5 秒。
- callback claim TTL：8 分钟；状态刷新看门狗上限：1 小时。

### 诊断原则

- 先看 reqId 和 transport 路线，再判断是模型错误、流投递错误还是主动推送错误。
- 不把错误文案出现当成模型请求第一次失败的证据。
- 不把 ACK 缺失直接当成消息未送达；只有企微明确拒绝码才可推进永久气泡书签。
- 不在渲染层做模糊语义去重；判断重复前先区分同一 item 快照、跨 item flush、真实模型重复和重复投递。

## 7. 当前验证证据

### 已完成

~~~text
OpenClaw: 2026.7.1-2 与 2026.8.2（npm run compat:check，两条线各一遍）
Vitest: 63 / 63 files，811 / 811 tests（两条线数字相同）
typecheck: 两条线 PASS（8.2 由 compat 脚本为 file-access-runtime 补类型 shim，8.2 该子路径不带 .d.ts）
npm run build / verify-dist: passed
B1: READY
B2: READY（BLOCK_PREVIEW_MAX_CHARS 字面量已同步为 5_000）
B3: READY
8.2 plugins inspect wecom --runtime --json: status loaded（channel、2 tools、service、2 http routes）
真实 mutateConfigFile 名册写入 e2e：7.1-2 list、8.2 entries / list / 空配置 均正确
~~~

本轮新增的复现用例（改这些路径前先跑）：
- long-task-progress「死窗后的收尾：答案正文随推送出门时不再押着「长任务处理中」的状态尾巴」
- gateway-sim「closes an ACK-untrusted bubble without its clock once the answer went out as a push」
- gateway-sim「finishes an externally answered bubble without the clock」
- gateway-sim「pushes new body text every 20 seconds once the window is dead while steps keep the minute grid」
- gateway-sim「keeps streaming a long answer into the bubble up to the frame budget」
- media.test「reads a local file that sits under an approved root」/「refuses a local file outside every approved root」
- dynamic-agent.roster.test 全部；openclaw-sdk-imports.test

负载提示不变：机器忙时 fake-timer 套件会撞 30 秒墙钟（本轮 gateway-sim「carries real narration」并发时 68–110 秒、单跑 0.7 秒）。**不要为掩盖负载抖动修改生产 timeout 或用例断言。**
差分用例 media-directive-alignment 的反向证据（改 stripMediaDirectives / mergeReplyText 时复跑）：关掉 stripMediaDirectives → 78 处缺陷；围栏状态机退回布尔量 → 24 处；looksLikeMediaTarget 恒真 → 12 处（2.7.260-25 记录，本轮未动这两处）。

### 包指纹

~~~text
yanhaidao-wecom-2.7.260-26.tgz
size:        611,374 bytes
unpacked:    2,320,890 bytes
files:       254
npm shasum:  ae5463b86bdf6d8c7fd84af5d20806ed768e2bbf
SHA-256:     b302822b28a51fb2285df1863363a9f6a4d233ba85cdb7c7c80cec4bdf78bb74
~~~

重复打包字节一致；包内无测试文件、无 node_modules、无凭据文件；含 dist/src/shared/byte-chunking.js 与 send-pacing.js。
（隔离 npm install --omit=dev 后 @wecom/cli-linux-x64 可解析、二进制返回 wecom-cli 1.2.0，为 2.7.260-25 时的验证，本轮依赖未变、未重做。）

全量命令：

~~~bash
npm run compat:check            # 2026.7.1-2 + 最新稳定版：typecheck + 全量 Vitest 各一遍
npx vitest run --pool=threads --maxWorkers=1 --minWorkers=1
npx tsc --noEmit
npm run build
npm run verify-dist
node scripts/patch-wecom-markdown-table.mjs --check
node scripts/patch-wecom-long-message.mjs --check
node scripts/patch-wecom-b3-merge-thinking.mjs --check
git diff --check
~~~

### 审核 agent 应重点复跑

~~~bash
npx vitest run \
  src/runtime/reply-orchestrator.test.ts \
  src/app/account-runtime.test.ts \
  src/transport/bot-ws/reply.test.ts \
  src/transport/bot-ws/gateway-sim.test.ts \
  src/transport/bot-ws/long-task-progress.test.ts \
  --pool=threads --maxWorkers=1 --minWorkers=1
~~~

重点测试名称：

- does not spin zero-delay timers while a frozen status ACK is in flight
- does not rearm frozen status after supersede while its ACK is in flight
- keeps an expired callback claim on recurring push without reviving its frozen stream
- does not claim a visible preview is complete when OpenClaw defers the final
- keeps long tasks alive when timeout-frozen status updates expire before final delivery
- delivers every long-final chunk after a task runs longer than ten minutes
- 死窗后的收尾：答案正文随推送出门时不再押着「长任务处理中」的状态尾巴
- closes an ACK-untrusted bubble without its clock once the answer went out as a push
- pushes new body text every 20 seconds once the window is dead while steps keep the minute grid
- keeps streaming a long answer into the bubble up to the frame budget

测试机负载较高时，fake-timer 套件可能超过默认墙钟预算；不要为了掩盖环境抖动修改生产 timeout。先隔离单 worker 复跑并记录断言类型。

## 8. 与官方实现的对账结论（2026-08-29 完成，下轮不必重做）

对照 WecomTeam/wecom-openclaw-plugin，HEAD 3b1cbe3（2026.8.17，最后一次功能提交 34452cd 于 2026-08-17）。
本轮拿到了官方**完整 TypeScript 源码**（15,627 行），此前只有 npm 包里的 dist。

- CLI 层：argv / const / credentials / locate / process-output / tool 与官方逐函数比对一致。常量全等（45s / 30s / 3s+3s / 64KiB / 5min）；CLI_RESIGN_CODES 含 853000 而 auth init 自身报 853000 绝不重试的**不对称**已落地；stdio ["ignore","pipe","pipe"]（非 TTY，cli 才走 --bot-id/--secret 直连）正确；禁用集、--config-dir/--home 拦截、目录 0700、(botId,secret) 指纹隔离、全局串行、5 分钟熔断全部一致。本 fork 在官方之上多了 secret 脱敏、endpoint 裁剪、allowAuth、via 标记。
- Skills：16 个目录与官方同名同内容。差异共 8 个文件且全部有意保留——wecomcli-preflight/SKILL.md 是**必须**的适配（本插件 ID 是 wecom，官方是 wecom-openclaw-plugin），其余 7 个只差行尾空白，本 fork 做过行尾空白规范化，逐字回同步会让 git diff --check 常红；已确认那些空白只影响人类渲染，模型读原始 Markdown 无差异。**不要再把这 8 个文件当作漏同步。**
- 媒体阈值：图片/视频 10MB、语音 2MB、文件 20MB，与官方 const.ts 完全一致。
- 多账号 fail-closed：resolveWecomAccount 对未知账号 ID 返回 createMissingResolvedAccount，resolveCliBot 随即因缺 botId/secret 抛错，不会回退到第一个账号。
- MCP → CLI 兜底路由：msg→message、schedule→calendar、doc→doc/sheet/smartsheet/smartpage/media 正确；mail 与 CLI 顶层命令同名，不需要别名。模型可控的 category 走不通 auth init（被 assertSafeArgv 拦下）。
- file-type 依赖：官方用它做魔术字节嗅探，其 openclaw-compat.ts 明写这是 SDK 缺 detectMime 时的**回退**。本 fork 直接用 SDK 的 detectMime（两条线都导出），能力等价，不引入该依赖。
- openclaw-compat.ts：官方用于跨 SDK 版本探测导出。本 fork 的做法不同：只用两条线都存在的子路径，静态守卫加 compat 矩阵，不做运行时探测。
- 上游同步度：官方 git HEAD 之后没有我们未同步的功能提交。
- 2026-09-02 对账 YanHaidao/wecom（origin）自分叉点 b4e297a 起的 25 个提交：Bot WS 车道没有必须补的修复；已移植 0d85ccb（Agent 车道字节切分）与 b28611d（1100ms 分片节流）；markdown.format 系列是 Agent 车道新功能、Bot WS 不需要；上游对 2026.8.x 零适配。

## 9. 模板卡片真机测试步骤

卡片能力在 2.7.260-21 新增。渲染与点选后就地更新**已在真机验证通过**；2.7.260-22 修的「选择结果送回 agent」这一段仍待真机复验。

1. 装包：把 tgz 复制到本地 NTFS 再 `openclaw plugins install "npm-pack:<本地路径>"`（映射盘/NAS 会触发 archive changed during validation）。
2. 确定性触发：直接要求模型原样输出一个卡片 JSON 代码块（见下），不要依赖它自行判断该不该发卡片。
3. 期望：聊天里出现**一张卡片**而不是一段 JSON 文本；代码块之外的文字作为普通回复单独到达。
4. 交互：点选项并提交，卡片应就地更新——控件禁用、提交按钮变「已提交」、选中项打勾。
5. 看日志关键行：`[wecom-card] sent account=… cardType=… taskId=…`、`[wecom-card] updated account=… taskId=…`。

失败形态与含义：

| 现象 | 含义 |
| --- | --- |
| 气泡里是裸 JSON | 抽取没生效。检查 card_type 是否是那 5 个合法值之一；不合法的代码块按设计**保留在正文里**。 |
| 气泡停在「📋 正在生成卡片消息...」 | 这一轮被 OpenClaw deferred，卡片没走到 final。属于遮罩的正常终态，不是卡片 bug。 |
| 卡片发出但点了没反应 | 查日志 `[wecom-card] update-skipped … reason=not-in-cache`：卡片缓存在进程内，网关在「发卡」与「点击」之间重启过就找不到原卡片。官方同样如此。 |
| 点选后 agent 回「已收到 … 事件」 | 2.7.260-21 的缺陷，已由 -22 修复。若在 -22 之后仍出现，说明 describeTemplateCardEvent 没拿到 selected_items，抓一份原始事件帧。 |
| 点选后 agent 回复里选项显示成 `b` 而不是「饭」 | 卡片缓存缺失（进程重启过），按设计退回原始 id，不是 bug。 |
| 正文出现「⚠️ 有 N 张卡片消息发送失败。」 | 卡片被企微拒绝。同一行日志 `[wecom-card] send-failed` 有原始错误。 |
| 日志有 `send-skipped … reason=missing-<field>` | 模型给的卡片缺核心字段（button_list / checkbox / select_list），插件补不出来，按设计不发。 |

注意企微要求收到 template_card_event 后**5 秒内**回复才能更新卡片，排查更新问题时先看这条链路有没有被别的耗时操作堵住。

## 10. 下一步与停止条件

### 现在不要做

- 不要重置或覆盖当前工作区改动。
- 不要把 devDependency 从 2026.7.1-2 挪走；新版 OpenClaw 用 `npm run compat:check <版本>` 验证，不换基线。
- 未获授权不要打 tag 或推送远端。

### 下一版发布时（需要用户明确批准）

1. 更新 package.json 与 src/version.ts（version.test.ts 会对账）。
2. `npm run compat:check`（两条线 typecheck + 全量 Vitest）/ build / verify-dist / B1 / B2 / B3 / diff check。
3. 打包并记录指纹，重复打包校验 SHA-256 一致。
4. 创建 released/<完整版本号> tag，只推 fork（git@github.com:liny90626/wecom.git），绝不推 origin。

### 改 reply.ts 时必看

B1/B2/B3 三个门禁脚本用**字面量匹配**校验硬化不变量。不只是重命名——**给被匹配的
调用加一个实参、或把它换行排版，同样会让门禁变红**。已经踩到两次：

- 把 const outboundText 改名成 composedOutboundText → B2 NOT_READY。
- 给 markFinalDelivered(currentFinalDeliveryKey, { peerDedup: … }) 加 isError 实参并
  换行 → B3 NOT_READY。

两次都选择改回原样、把新逻辑挪到别处（后者把「错误不是最终结论」的策略放回
deliver 的调用点，markFinalDelivered 保持成纯去重原语），**没有去改门禁脚本**。
门禁是防止硬化语义被无意识改掉的，为了让它变绿而放宽它就失去了意义。

改动这些位置前先跑：

~~~bash
node scripts/patch-wecom-markdown-table.mjs --check
node scripts/patch-wecom-long-message.mjs --check
node scripts/patch-wecom-b3-merge-thinking.mjs --check
~~~

高负载下每个脚本要跑几分钟（内部会跑构建与聚焦测试）。

### Windows 包安装排障

如果再次看到：

~~~text
archive changed during validation
Also not a valid hook pack
~~~

先独立验证 tarball 的 SHA-256 和解包内容；然后把包复制到本地 NTFS，再执行：

~~~bash
openclaw plugins install "npm-pack:<local-package-path>"
~~~

不要仅凭这两行 fallback 文案判断 tarball 已损坏。
