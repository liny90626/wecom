# SESSION HANDOFF — OpenClaw WeCom 插件维护交接

> 最后更新：2026-08-02（`2.7.260-3` 已发布）。新会话开工前先读本文件、`README.md`、`changelog/README.md` 与最新版本简报。

## 1. 当前状态

- 已发布正式版本：**`2.7.260-3`**，发布标签 `released/2.7.260-3`，包 `yanhaidao-wecom-2.7.260-3.tgz`（216,611 bytes；139 文件；npm shasum `df992d2c56cbc854bd72b9839900cbe3853881e2`；SHA-256 `039fd648cc6767cc0154955e4c8e44cd31e4b70a68809c231c75a95dd9071122`）。本版恢复 OpenClaw commentary/preamble 真实过程文字，并把长任务辅助状态从 15 秒降频到 60 秒、缩短为 `【任务处理中，已用时 X】`，详见第 2h 节；只改两处生产文件及三份回归测试，没有增加重试、熔断或额外看门狗。
- 上一版：`2.7.260-2`，发布标签 `released/2.7.260-2`；该版修复完成态释放竞态与同一 Bot WS 错误重复记录，详见第 2g 节。
- v149 修复「文件+文字互相丢一半」「长任务产出被后台提示丢弃」「一次主动推送永久熄灭长任务反馈」，见第 2c 节；v148 修复「失败长任务只剩一行 `LLM request failed`」并优化长任务提示词，见第 2b 节；v147 修复现网反馈的三类问题（莫名失败提示、长任务无过程信息、思考块经常不出现）。
- 生产环境：OpenClaw **2026.7.1**；仓库 devDependency 同为 **2026.7.1**，`peerDependencies` 仍为 `^2026.6.11`（**上游已收窄到 `^2026.7.0`，我们刻意不跟**，见第 2f 节），**代码必须继续双版本兼容**（v147 用到的 `abortAgentHarnessRun` 已核实 6.11/7.1 均导出且同为同步 boolean 契约）。
- 企业微信 Bot SDK：`@wecom/aibot-node-sdk` **1.0.7**（固定版本）。
- 远端纪律：**只推 `fork`（git@github.com:liny90626/wecom.git），绝不推 `origin`（上游 YanHaidao）**；从 `origin` **拉取/合并**是允许且必要的（见第 2f 节），禁止的只有推送；提交邮箱固化为 `liny90626@users.noreply.github.com`（GH007 教训）。
- `2.7.260-3` 发布验证：OpenClaw 2026.7.1 下 44 文件 / **517 测试全绿**，build/typecheck/dist/B1/B2/B3/diff-check 全绿；真实 OpenClaw 2026.6.11 包下全项目类型检查及聚焦 3 文件 / **232 测试全绿**。6.11/7.1 真实 dispatcher 契约探针均成功转发 preamble 并正常产生 final；旧实现已分别复现缺失回调与 15 秒高频刷新。
- `reply.test.ts` 与 `gateway-sim.test.ts` 头部都有 `vi.setConfig({ testTimeout: 30_000 })`：这两套 fake-timer 密集，全量并发冷缓存下墙钟可超默认 5s。不要改回全局 timeout。
- 涉及释放等待的 dispatcher 用例必须用 `vi.useFakeTimers()` 并在 `finally` 里 `vi.useRealTimers()`，否则污染后续用例（已发生过一次超时）。

## 2. v147 事件档案（现网三条反馈 → 根因 → 修复）

现网反馈：①「⚠️ Something went wrong…」莫名出现且比以前频繁；②长任务只回 `LLM request timed out.`，全程无任何过程信息；③思考块经常不出现，偶发「发了没回复，再发一条才显示」。

**复现手段（关键）**：`src/test-utils/wecom-gateway-sim.ts` 忠实建模 SDK 1.0.7 的投递层——每个 `req_id` 一条串行队列、同时只允许一帧待回执、5 秒回执超时后丢弃该帧并继续下一帧、`replyStreamNonBlocking` 在有待回执时返回 `"skipped"`——再加上企微「一帧流式内容整条覆盖气泡」的渲染规则。**只有把这两件事一起建模，三条反馈才复现得出来**；此前的单元测试用的是永远秒回执的 mock，所以从未触发。

1. **一次丢失的 ACK 让整轮进度永久失声**（对应 ②③）。`isTerminalReplyError` 把「回执超时」和「流已死」当同一件事，任何一帧 5 秒未回执就永久熄灭进度通道：后续所有思考块、块预览全部被丢弃，用户盯着「⏳ 正在思考中…」直到任务结束，答案再以另一条新消息推来。长任务每几秒发一帧，命中概率很高——这正是「机率性」的来源。
   → 拆成两个latch：只有 **846605 / 846608**（未知 req_id、流窗口过期）才退休通道；**回执缺失只标记该 `req_id` 的回执账本不可信**（`streamAckUnreliable`），进度继续画，而必须证明送达的动作（final、收流、接管提示）照旧改走主动推送。**持续型**失败（整个宽限窗口都有帧待回执）仍然退休通道并转后台通知。
2. **错误 final 抹掉用户正在看的过程**（对应 ②）。企微流式帧整条覆盖气泡，`LLM request timed out.` 一来，`<think>` 块连同全部进度瞬间消失，用户看到的就是「过程没有任何其他信息」。
   → 错误 final 现在把思考块一起带上。思考块只占用该帧**剩余**的字节预算（`prependThinkingWithinFrameBudget`），答案自身的分段限额不变。
3. **被接管回合的核心失败文案被当成新消息推给用户**（对应 ①）。会话交接本身就是终结旧 run 的原因，旧 run 的失败文案对用户毫无价值，却以主动推送落在新答案旁边。
   → 被接管 + `isError` 且**不带媒体**的 final 直接静默丢弃；**被接管回合的真实答案、以及带媒体的 final 仍然照旧推送**（各有专门用例守住）。
4. **v146 把接管公告推迟到排空之后，开了一个「杀掉的 run 仍然在线」的窗口**（对应 ①，频率变高的直接原因）。v146 之前 `registerActiveBotWsReplyHandle`（也就是通知上一轮「你被接管了」→ abort 它的 replyOperation）发生在预派发排空**之前**；v146 移到了**之后**，于是从「在 harness 层杀掉旧 run」到「告诉旧 dispatch 它被接管」之间有最长 settle+释放等待的空窗。OpenClaw 只有在 replyOperation 已被中止时才把 harness abort 判为静默的 user abort，空窗期内被我们杀掉的 run 会把自己算成失败并把文案投出来。
   → 改用同步的 `abortAgentHarnessRun` 取回「是否接受中止」，**接受的那一刻同一 tick 内发布接管**；被拒绝（7.1 冻结中止＝健康 run 正在提交答案）则完全不碰旧回合，保留原有有界释放等待与拒收路径。释放等待轮询从 150ms 降到 50ms（纯交接延迟）。

**独立 code review 追加的三处修复**（都已补回归用例并做过敏感性验证）：

- 思考块前缀原本从**答案**的分段预算里扣（`resolveThinkingAwareBodyLimits` 是预览通道的辅助函数，从 3500 字符上限扣前缀），且缩小后的限额被一路传进续文推送：3000 字符思考块 + 4500 字符错误 final 会从 2 条推送变成 5 条。改为思考块只吃该帧**剩余字节**，答案分段完全不变。
- 只丢回执的流原本再也走不到 9 分钟后台通知：挂载点原来在「通道退休」分支，而「持续型」截止分支对纯回执超时不可达（SDK 在自己的 5 秒超时时出队，`hasPendingReplyAck` 早已变 false）。改为回执 latch 触发即挂载，**预览一旦确认送达就撤销**。
- 被接管失败文案的抑制会连同该 final 携带的媒体一起吞掉，已限定为纯失败文案。

## 2b. v148：`LLM request failed` 的定位与处置

**这句话不是插件生成的，也不是超时。** OpenClaw 用 `formatUserFacingAssistantErrorText`（`errors-XbAR6hS3.js`）生成给渠道的文案：分类器无法改写原始错误时（`rawPassthrough` 且非 schema 类），它**无条件丢弃原始文本**，只返回固定的 `LLM request failed.`，再作为 `{text, isError:true}` 进入回复载荷（`payloads-slKkO7u6.js`）。插件收到的就是这一行，**看不到也无法恢复真实原因**。这一支不带任何分类，也**不会触发 OpenClaw 的模型回退重试**——配 fallback 模型对它无效。长任务的模型请求次数远多于短任务，因此表现为「偶发、只在长任务」。

插件侧只能负责「失败之后用户还剩什么」：

1. 走推送路线的错误 final 带上框架与耗时（`withFailureContext`）：长任务失败时流窗口早已关闭，final 必然改走主动推送，而该分支原样返回错误文本。**推理不外泄**，只在折叠 `<think>` 块里出现。
2. 耗时在首次使用时**快照**：这段文案就是重试身份，时间戳漂移会重置分片进度并重推已送达分片（已有专门用例）。
3. 新增 `[wecom-reply] error-final` 日志（耗时、正文/思考字数、`streamDead`/`ackUntrusted` 路线、截断文案）。**下次复现就用它的时间戳+reqId 去对齐网关日志里的 `embedded run agent end … rawError=…`**，那里才有被隐去的原始错误。

长任务进行中的提示统一为 `LONG_TASK_FOCUS_NOTICE_TEXT`（「正在专注任务中…尽量不要打断我…」）+ `当前长任务用时X`，冻结气泡后缀与 9 分钟后台推送共用；耗时格式化拆为 `formatElapsedDuration`。

## 2c. v149：入站合并与长任务产出

**① 文字在前、文件在后 ⇒ Agent 只看到文件。** 适配器只为**媒体**帧保留 1 秒合并窗口（`MEDIA_FIRST_TEXT_MERGE_WINDOW_MS`），文字帧立即派发。所以「先打字、后附文件」时：文字回合已经在跑，文件作为独立入站进来，而此时文字的 pending 记录早已在 `activate` 前被移除 ⇒ 无法并入；文件的预派发守卫再把文字的 run 杀掉，最终只带文件进 OpenClaw。**复现**：`dispatcher.test.ts > carries a running message's text into the file that arrives right after it`，修复前 `ctx.Body === "[file] report.pdf"`。

**反向同样有问题：先附件、后文字。** 裸文件会让 Agent 很快给出可见回复（「收到一个 PDF，需要我做什么？」），等用户打完字，那个回合早已有可见输出——于是并入被整体挡掉，指令带着**零附件**进 OpenClaw。**复现**：`dispatcher.test.ts > carries the attachment forward even after the file's own turn started replying`。

修复：pending 记录**保留到该次 dispatch 结算**（原来在核心派发前删除），后继消息因此可以并入一个「它即将杀死」的回合。三条边界：

- 已经进入 OpenClaw 的前驱**不在注册时 supersede**——只有被接受的中止才能认领 peer，否则 busy 拒绝路径会丢掉它正在提交的答案（禁改 9）；
- **附件永远随行**：它是新指令需要的**输入**，不是用户已看到的产出；媒体事件自己的正文只是 `[file] <url>` 标签，丢掉不损失信息；
- **前驱正文**只在用户**尚未看到该回合任何可见输出**（`hasVisibleReplyBody` 或 final）时随行，避免重跑用户正在读的回复。

**② 长任务的产出被后台提示丢弃。** 流窗口关闭后气泡无法再刷新，但 Agent 仍在产出；9 分钟后的循环推送只带状态行，于是这段产出直到 final 才出现（现网案例：两条纯提示气泡覆盖了整整一分钟的真实输出）。

修复：后台推送先带上**用户尚未看到的可见正文**，再接状态行；**只有推送成功后**才推进 `recordDeliveredBodySource` 的已投递书签——final 用同一份书签算续文，因此既不重复也不丢。推理不参与（只在折叠 `<think>` 块内展示），`visibleReplyStarted` 也刻意不置位，保证之后被接管时剩余答案仍会推送。

### v149 第三项：外部活动不得熄灭长任务反馈

**子任务返回推到企微是 OpenClaw 的设计，不是插件行为。** `sessions_spawn` 默认 `mode:"run"`（结果作为工具返回值回父 agent）；到达企微的是**完成通知**——OpenClaw 把子任务结果作为提示投给**父会话**，`expectsCompletionMessage` 默认 `true` 走 direct 优先：父会话在跑就 steer 进当前回合，已空闲则新起一个父回合并把**它的答复**投到渠道。要关闭得在 OpenClaw 侧调 `mode` / `expectsCompletionMessage` / `subagent_delivery_target` hook；插件拿到的 sessionKey 是父会话的，无法区分。

**但插件被牵连出一个真缺陷**：outbound 每次主动推送后调 `markExternalActivity()`，它原本 `stopPreviewStatusInterval()` + `cancelPreviewExpiredNotice()`，而后者是**永久闩锁**。于是长任务途中只要发生过一次主动推送（子任务完成通知最常见），该回合此后**再无任何进度反馈**——这是独立于「丢 ACK」和「流窗口过期」的第三条静默成因。

修复：改为**顺延一个间隔**（重置状态计时 + 按重复间隔重挂通知）。只有**已启动过**的循环才可顺延，外部活动永远不会为健康的流凭空挂通知；推送在途时 `schedulePreviewExpiredNotice` 自身 bail，其 `finally` 只补挂一次，因此不会重复挂载。

## 2d. v150（`2.7.260-1`）：零产出长任务为什么全程静默

现网案例只有两个气泡：`正在思考...` 和 10m08s 后的失败文案。**从这两个气泡可以确定性推出**：（1）占位气泡 10 分钟没被改写过 ⇒ 没有任何一次预览成功送达；（2）9 分钟的后台通知**完全没出现** ⇒ 它从未被挂载——而它的挂载点只有「预览遇到死流 / 预览回执超时 / pending 预览超期」三处，**全都要求先发生过一次预览发送尝试**。结论：这一轮插件**根本没拿到任何可画的内容**，不是画了画不出去。跟 v147（丢回执）、v148（错误文案）、v149（外部活动）都不是同一条路径。

**根因（源码级）**：OpenClaw 的 `reasoningMode` 默认 `"off"`（`selection-8ixiqbew.js`：`params.reasoningMode ?? "off"`），而 `streamReasoning = (streamReasoningInNonStreamModes === true ? reasoningMode !== "on" : reasoningMode === "stream") && ...`。插件没有设 `streamReasoningInNonStreamModes`，所以 **`onReasoningStream` 根本不会被调用**；纯工具型回合也不产生 assistant 文本，于是没有 block。插件订阅的三个来源（reasoning / tool-result（只留 fast） / block）在这种回合上**全部为空**。

**为什么不是「再加一层保护」**：插件当时的三条反馈通道**全部以模型产出为前提**——占位保活重复同一句静态文本且 120 秒后停、冻结状态刷新要求已渲染过预览、后台通知要求先有一次**失败的**预览发送。真正的缺陷是「反馈依赖产出」这个前提本身。

**修复：把心跳改成时间驱动，并删掉旧机制。**

- 占位保活升级为回合心跳：超过 `LONG_TASK_STATUS_AFTER_MS`（30s）后渲染 `formatElapsedStatus(elapsed)` 而不是静态文本，节奏由 3s 放慢到冻结状态同款的 15s，上界改用既有的 1 小时看门狗。**删除** `MAX_KEEPALIVE_MS`(120s) 及只为延长它而存在的 reasoning 重置计时器。
- 心跳在预览通道渲染出任何内容后立即让位（`lastPreviewText` 守卫），绝不覆盖真实进度。
- 心跳撞上死流时**退休通道并交给后台推送**，不再 `settleStream()`——后者会连带取消那条推送，正是「静默到底」的最后一环。
- 外部活动**顺延**心跳而不是杀掉它（与 v149 对后台通知的处理一致）。

**帧数实测**：静默 10 分钟共 **33 帧**流式 + 2 条后台推送；旧行为是**前 2 分钟 40 帧、之后彻底静默**。所以这是**更少的流量 + 全程有反馈**。

**失败本身（`LLM request timed out.`）不是插件问题**：OpenClaw 默认 run budget 是 48 小时（`DEFAULT_AGENT_TIMEOUT_SECONDS = 2880*60`），排除预算超时；`isTimeoutErrorMessage` 会把 `connection error / network error / fetch failed / socket hang up / ECONNRESET` 一并渲染成这句话。本例 **10m08s ≈ 608 秒**非常接近 600 秒边界，典型来源是模型网关前置代理的 `proxy_read_timeout`。且本轮没有任何 block 投递，插件对 OpenClaw 的 dispatcher **零背压**，不可能是插件造成。**要定案只需一条证据**：用插件的 `[wecom-reply] error-final`（含 elapsed/reqId）去对齐同一时刻 OpenClaw 网关的 `embedded run agent end … rawError=…`。

## 2e. v150（`2.7.260-1`）：「漏消息」审计——交付链上每一个丢弃点

现网反馈「v149 仍会漏消息」，要求**所有 OpenClaw 侧过来的真实消息都不得遗漏**。对 `deliver` 全链路逐条枚举丢弃点后，分成三类：

**A. 合法丢弃（无内容损失）**：`wecomExternalFinalDelivered`（外部已送达）· 空 block / 空 final · block 预览节流（正文已进 `accumulatedText`）· 同 key 的 final 去重（key 含 `reqId`，跨回合不会误杀）· event 回合不支持流式分片（正文仍进最终推送）· 推理与 fast 进度（设计上不作为可见正文）。

**B. 需要接管才会发生（B3 语义，窄）**：`superseded-final-skip-error` · `superseded-final-skip-visible` · `superseded-final-stop-after-media` · `stream-remainder-skip-superseded`。注意：被接管必然伴随 abort，而 orchestrator 在 `abortSignal.aborted` 时就丢掉了 final，**所以 reply 侧这几条大多根本走不到**；且被中止的 run 通常返回 `SILENT_REPLY_TOKEN`，本就没有真实 final。

**C. 真实丢失（已修）**：**`shouldCancelForNewActivation` 会因为「有新一代活跃了同一个 peer」而取消一条尚未送达的 final 重试**。判据是 `!supersededByNewInbound`——对**任何一个正常结束的回合都为真**。于是：回合 A 结束 → final 推送失败（用户什么都没收到）→ 重试排在 20 秒后 → 用户在这 20 秒内发了下一条 → **A 的完整答案被永久销毁**。**不需要接管、不需要 abort**，这就是它躲过前几轮的原因。

修复：只在**本次推送已有分片确认送达**（`finalPushProgress.delivered > 0`，重推会重复）时才取消。这同时把行为与禁改 2 已经写明的取舍对齐了——有界重复可以接受，静默丢失不可以。`runFinalPushRetry` 在执行点重算接管抑制的逻辑不变（禁改 5）。

**D. 已识别但未证实**：同一个 handle 上出现**第二条内容不同的 final** 会被 `markFinalDelivered` 静默丢弃（去重是为同一答案的重试设计的）。企微上没观察到实例，已加 `[wecom-b3] final-skip second-distinct` 警告日志，出现即可证实。

## 2f. 上游同步（`2.7.260-1`）：与 `YanHaidao/wecom` 的分歧点

上游在 2026-07-26 推了 4 个提交，**全部只动 `package.json`**（无代码变更），已用 `git merge origin/main` 合入主线。冲突逐条处置如下。**下次再合上游时照这张表处理，不要机械接受上游值。**

| 字段 | 上游 | 合并前的我们 | 处置 | 原因 |
| --- | --- | --- | --- | --- |
| `version` | `2.7.260` | `2.5.110-149` | **`2.7.260-1`** | 基线跟上游走；基线一变，构建号从 1 重新计数 |
| `peerDependencies.openclaw` | `^2026.7.0` | `^2026.6.11` | **保留我们的** | `^2026.6.11` = `>=2026.6.11 <2027.0.0`，已覆盖 2026.7.x，是上游区间的**超集**；换成上游值会把 6.11 用户挡在门外，违背双版本兼容要求 |
| `devDependencies.openclaw` | `^2026.7.0` | `^2026.7.1` | **保留我们的** | 自测必须跑在与生产一致的 2026.7.1 上，下限更高才有约束力 |
| `devDependencies.@types/node` | `^22.22.0` | `^25.2.0` | **`^22.20.1`**（取上游意图、改正其值） | 见下方专条 |
| `dependencies` 三项 | `^1.0.0` / `5.3.4` / `^7.20.0` | `1.0.7` / `5.10.1` / `7.28.0` | **保留我们的精确钉版** | `reply.ts` 的整套传输模型是对 SDK **1.0.7** 源码的建模（串行回执槽、5s 回执超时、`replyStreamNonBlocking` 的 `"skipped"`）；插入号会让实际安装版本漂移，模型随之失效 |
| `scripts.prepack` | 无 `rm dist` | 先删 `dist` | **保留我们的** | 防止陈旧 `dist` 混进发布包 |

`dependencies` 与 `prepack` 两项上游本轮没动，三方合并自动保留了我们的值——但它们同样是刻意选择，未来上游若改到同一行会冲突，按上表处置。

**`@types/node` 单独说明**：上游写的 `^22.22.0` **在 registry 上并不存在**——22 线最高只到 `22.20.1`，`npm view @types/node@^22.22.0` 返回 404，任何干净的 `npm install` 都会失败（这也是全量安装卡死的原因）。但上游的**意图**是对的：类型不应跑在运行时前面。`^25` 的类型领先于本机 Node 24，是唯一"编译通过、运行时才崩"的危险方向；把类型下限钉在最老的可能运行时上，误用新 API 会在编译期就被抓住。因此取其意图、改其值为 `^22.20.1`，并实测 `tsc --noEmit` 干净。

## 2g. `2.7.260-2`：完成态后的投递中断与重复后台错误

### ① 上一轮已完成后偶发「本次回复投递中断」

OpenClaw 6.11/7.1 的 `finishReplyOperationBusyDispatch` 和 inbound dedupe 都返回相同的 **flagless zero**：`queuedFinal=false`、三类 count 全为 0，且没有“busy”字段。配置允许 silent reply 时，一个真正已接收的静默回合也会返回这个形状。旧插件在返回之后再查 active run：有 run 就按 busy 重试，无 run 就抛 `WeComReplyNoVisibleOutputError`。上一轮答案虽然已完成，reply-operation 仍可能短暂处于终态提交；它恰好在核心返回与 active 查询之间释放时，查询结果从有变无，正常的收尾占用便被误判成真实零输出——这是一个确定的 TOCTOU。

修复把“当前还有没有 active run”降为纯诊断，改用本次调用的接收事实：

- 6.11/7.1 都有 `onAgentRunStart`，证明本次确实启动过 agent；7.1 另有 `onTurnAdopted`，能证明消息已成功 steer，即使被并入的 run 在结果分诊前已经释放也不丢事实。
- 未触发任何接收回调的 flagless zero 固定走**现有一次** 500ms 有界重试；第二次仍未接收才提示「确认新指令未执行后再重试」，不再制造投递中断。
- flagless 也可能是 dedupe，所以这条重试**只等待，不调用 `abortAndDrainAgentHarnessRun`**；否则可能中止另一条正在正常处理的同消息。明确的 session-init conflict 仍保留原 drain。
- 真正启动过 agent 且带 `noVisibleReplyFallbackEligible` 的零输出继续失败；`beforeAgentRunBlocked` 即使因 silent-reply 策略变成 flagless 也继续失败，不会被伪装成已接收静默回合。

### ② 同一个英文错误出现两次后台提示

`failAndThrow(error)` 先调用 tracked `replyHandle.fail(error)`；`WecomAccountRuntime` 在这里已经记录一次 operational issue，并由 Bot WS handle 发送一次失败提示。随后同一个 error 被原样抛出，旧 runtime 又把它抛到 `BotWsSdkAdapter.reportFrameError`，frame 边界再记录一次 operational issue。因此两条英文内容完全相同，不是两次模型失败，而是同一异常跨了两个记录边界。

修复只收口满足全部条件的异常：Bot WS；tracked `replyHandle.fail()` 已成功返回；catch 到的仍是**同一个错误对象**。未经过 fail、fail 尚未完成、不同错误对象、以及非 Bot WS 异常都继续上抛。这样保留一次用户提示和一次 operational issue，同时不吞掉真正的 frame/runtime 崩溃。

## 2h. `2.7.260-3`：真实过程文字恢复与辅助提示降频

### ① OpenClaw 有过程文字，但企微只显示插件提示

根因在插件与 OpenClaw 的接缝：`dispatchRuntimeReply` 只订阅 reasoning、block 和少量 Fast 状态，没有订阅 6.11/7.1 已提供的 `onItemEvent`。OpenClaw 产生的 commentary/preamble 因此在插件入口前直接丢失；当 reasoning 默认关闭、长任务又主要由工具组成时，用户看到的就只剩插件按时间生成的辅助状态。旧实现接入真实 dispatcher 的复现探针明确报出 `params.replyOptions.onItemEvent is not a function`。

修复使用 OpenClaw 自带的渠道进度契约，而非合成过程文字：

- 开启 `commentaryProgressEnabled` 与 `suppressDefaultToolProgressMessages`，让渠道接收结构化 item 事件并避免 OpenClaw 默认工具摘要与渠道进度重复。
- `onItemEvent` 只转发 `kind === "preamble"` 的真实过程文字；命令执行、审批、工具状态等内部事件不冒充正文。
- 同一 item 的累计快照原位更新，不同 item 按首次出现顺序合并；没有 `itemId` 的事件仍保持发生顺序。慢 ACK 时只保留最新待投递快照，避免旧快照排成长队。
- 复用既有 detached progress lane，回调不等待企业微信网络；回合结束时仍使用 500ms 短屏障，保证 final 不越过已经收到的过程文字，又不让坏 ACK 长时间拖住答案。

### ② 长任务辅助状态过于频繁且文案太长

冻结预览与静默任务状态过去每 15 秒刷新一次。旧版网关模拟中，冻结气泡在 59 秒内从 1 帧增长到 5 帧，且每帧都携带很长的「请勿打断」文案。现在共用的刷新间隔改为 60 秒，状态缩短为 `【任务处理中，已用时 1m30s】`。满 30 秒的首次状态、入站后 3 秒占位确认、真实过程一到立即让位、9 分钟后台兜底和最终正文投递均保持原契约。

## 3. OpenClaw / 企微 SDK 核心机制速查（源码级已验证）

- **企微 SDK 1.0.7 投递层**（`node_modules/@wecom/aibot-node-sdk/dist/index.cjs.js`）：
  - 每个 `req_id` 一条 FIFO 队列，队首发出后等回执；`replyAckTimeout` 默认 **5000ms**，超时即 reject 该帧并继续下一帧。
  - **回执只按 `req_id` 匹配**：某帧超时后，它迟到的 ACK 会 resolve 下一帧的 Promise。所以「必须证明送达」的动作在回执可疑后要离开该流。
  - `replyStreamNonBlocking(finish=false)` 在有待回执时返回 `"skipped"`，不排队；`finish=true` 始终排队发送。
  - 插件本地超时 `WECOM_REPLY_SEND_TIMEOUT_MS = 8000` > SDK 的 5000，正常情况下 SDK 的错误先到。
- **会话准入错误（run 前抛出，可安全重试一次）**，插件按文案匹配（`src/shared/reply-errors.ts`，有逐字单测）：
  - `reply session initialization conflicted for <sessionKey>`（6.11/7.1 皆有）
  - `Session "<sessionKey>" changed|was deleted while starting work. Retry.`（7.1 新增）
  - `timed out draining work before reply session rollover: <sessionKey>`（7.1 新增）
- **abort 语义**：`abortAgentHarnessRun(sessionId)` 同步返回 boolean（6.11/7.1 一致）。7.1 的 `abortEmbeddedAgentRun` 多了 `isEmbeddedRunHandleAbortable` 检查——**只有 Codex app-server 后端实现了 `isAbortable`**（终态冻结期返回 false），主嵌入式后端未实现，恒可中止。中止被接受后 OpenClaw 会走 `onAttemptAbort → replyOperation.abortByUser()`，前提是该 operation 尚未 `freezeAbort()`/`fail()`；**这正是接管必须与中止同 tick 发布的原因**。
- **失败文案来源**：run 前失败 → `Embedded agent failed before reply: …`，用户侧默认只看到 `GENERIC_EXTERNAL_RUN_FAILURE_TEXT`（详情需 verbose）。`isTimeoutErrorMessage` 命中 `timeout|timed out|connection error|socket hang up|fetch failed` 等，会把连接类错误也渲染成 **`LLM request timed out.`**。
- **forceClear 危险**：无属主校验，会把健康 run 打成 `run_failed`。**插件已彻底不用，预派发守卫里连这个入口都不存在。**
- **零输出结果分诊（已核对 6.11/7.1 核心源码）**：
  - `onAgentRunStart`（6.11/7.1）与 `onTurnAdopted`（7.1）是本次调用的接收事实；active-run lookup 是返回后的瞬时诊断，不能反推本次是否被接收。
  - `noVisibleReplyFallbackEligible=true` + 零计数 + 无活动：7.1 已触发 `onTurnAdopted` 且未启动新 run ⇒ 消息已 steer；6.11 没有该回调，只能保留 active lookup 兼容信号。真正启动过 agent 或 `beforeAgentRunBlocked` 的零输出仍是失败。
  - **flagless** zero-output 可能来自 reply-operation busy、inbound dedupe，或允许 silent reply 的已接收回合。已接收回合静默收口；未接收结果允许一次 500ms 重试，但不得 drain。
  - 默认 queue mode 是 `steer`。

## 4. 生产观察关键词

`[wecom-b3] pending-inbound-adopted|dropped dispatched=true|false`（v149：`dispatched=true` 表示并入的是一个已进入 OpenClaw 的回合）· `pre-dispatch-run-drain` · `pre-dispatch-run-drain-result aborted=… released=…` · `pre-dispatch-run-release-wait released=true|false`（仅在中止被拒绝时出现，7.1 特有） · `pre-dispatch-run-busy` · `dispatch-handoff-retry reason=init-conflict|busy-result`（仅一次；`busy-result` 不 drain） · `dispatch-absorbed-by-active-run` · `dispatch-busy-not-accepted` · `dispatch-adopted-silent-reply` · `dispatch-deferred-no-visible-reply` · `dispatch-failure-contained`（同一已处理 Bot WS 错误在 runtime 边界去重） · `superseded-final-skip-error`（v147：被接管回合的核心失败文案已丢弃） · `superseded-final-skip-visible` · `[wecom-reply] error-final`（v148：错误 final 的耗时/正文规模/投递路线，用于对齐网关 rawError）· `[wecom-preview] update-ack-missing`（v147：某帧未回执，进度继续、投递改道） · `terminal-update-stopped`（846605/846608，通道退休） · `update-delayed-expired` · `expired-notice progressChars=N`（v149：N>0 表示这次后台推送带出了新产出） · `progress-delivery-failed` · `progress-drain-timeout` · `final-retry-failed ambiguous=…` · `final-retry-exhausted` · `[wecom-ws] merged media+text`。

- `update-ack-missing` 偶发是正常网络抖动；**持续大量出现**说明企微网关回执普遍变慢，此时 final 会长期走主动推送（答案以新消息到达、气泡停在最后一帧进度）。
- `pre-dispatch-run-release-wait released=false` 频繁 ⇒ 旧任务 >3s 仍占住会话，优先查 OpenClaw active run/诊断日志，**不要在插件侧 forceClear**。

## 5. 禁改事项（每条都对应真实事故）

1. **不要恢复 forceClear / 分钟级等待 / 重试阶梯 / per-peer 熔断器 / synthetic thinking**（v132-v135 灾难线）。
2. **不要把 ambiguous 推送失败改回「不重试」**——会复发 v139 问题1（答案永久静默丢失）。重试必须复用**失败现场的同一 retryRequest 身份**（text/marker/limits）。
3. **不要给纯思考预览置 `visibleReplyStarted`**——判定依据是 `bodySourceText` 字段**存在性**（可为空串），不是真值。
4. **不要在 flag-empty 分诊前删掉 abort 守卫**、不要让被接管 handle 产生任何合成 final。
5. **`runFinalPushRetry` 的接管抑制要在执行点重算**（`supersededByNewInbound && visibleReplyStarted && delivered>0`）。
6. 最终回复保持被动 `replyStream` 路径；不动 12000 字节上限（v147 的思考块前缀是从同一预算里扣，不是加上限）；预览冻结 5 分钟受微信 ~6 分钟流窗硬限制约束。
7. **不要在 OpenClaw reasoning/Fast 回调中重新直接等待企微网络请求**（v142 反向背压）。
8. **所有跨请求全局状态都必须带完整作用域或属主身份**；注销必须校验原注册对象。
9. **接管必须与「旧 run 可释放」的证明同时发生**（v147 重写）：接管的发布点是 `abortAgentHarnessRun` **返回 true 的同一 tick**；中止被拒绝的 busy 路径**永远不得接管**，否则会丢掉旧回合正在提交的答案。
10. **不要把 `retryFlaglessBusy` 扩大到 fallbackEligible/deferred**：`fallbackEligible` 意味着消息**已被核心接收**，重投＝重复执行。
11. **不要提前释放 runtime owner，也不要允许旧 reply 使用 replacement push handle。**
12. **不要删除媒体 `dedupeAliases` 或群聊 merge key 中的 `senderId`。**
13. **不要把 `startPlaceholder` 合回 `activate`**（v146）：占位气泡必须在入站被接受时立即发出；`activate` 仍须留在确认接管之后，因为它会作废上一代的 pending final retry。
14. **不要让被接管的 pending 消息直接丢弃**：正文/附件必须并入后继消息；合并**必须**限制在同一 `senderId` 且双方均非 event/welcome。
15. **不要把空 final 写成 `content=""`**：企微流式帧是整条覆盖，必须用最后可见预览收口。
16. **不要删掉 `pre-dispatch-run-release-wait` 那条有界等待**：7.1 长任务收尾会拒绝中止，去掉它就退回「每个长任务后的下一条消息被拒收」。
17. **不要把「回执超时」重新并回 `isTerminalReplyError` 的通道退休分支**（v147）：`isDeadStreamError`（846605/846608）才能永久熄灭进度通道，回执缺失只能置 `streamAckUnreliable`。合并回去会直接复发「思考块经常不出现」。
18. **不要让 `streamAckUnreliable` 放行 final / 收流 / 接管提示**：SDK 只按 `req_id` 匹配回执，迟到 ACK 会 resolve 下一帧，误判「已送达」＝静默丢答案。这三处必须继续走 `streamDeliveryUntrusted()`。
19. **不要让被接管回合的纯失败文案 final 复活**（v147），但**不得**顺手把非错误的 final 或带媒体的 final 一起丢掉——旧回合的真实答案与产物仍要送达。
20. **失败文案里的耗时必须快照，不能每次重算**（v148）：`resolveStreamFallbackText` 的输出就是 final 重试身份，时间戳漂移会让 `resolveFinalPushProgress` 认不出同一次推送，把已送达分片重推一遍。
21. **不要把推理内容放进主动推送**：推理只在折叠 `<think>` 块内展示，任何 push 文案都不得包含它。
22. **pending 记录必须保留到 dispatch 结算**（v149）：删早了，「先打字后附文件」就会只带文件进 OpenClaw。但**已派发的前驱不得在注册时 supersede**；**附件必须永远随行**（输入），**前驱正文**只在用户尚未看到其可见输出时随行（否则重跑已在屏幕上的回复）。
23. **后台长任务推送推进已投递书签必须在推送成功之后**（v149）：提前推进会让 final 的续文跳过这段正文＝静默丢失。
24. **`markExternalActivity` 只能顺延、不能退休长任务反馈**（v149）：`cancelPreviewExpiredNotice()` 是永久闩锁，放在这里会让一次主动推送（子任务完成通知）永久熄灭该回合的全部进度反馈。顺延时只允许对**已启动过**的循环操作。
25. **长任务反馈必须时间驱动，不得回退成内容驱动**（v150）：OpenClaw 默认不流式推理，纯工具回合零产出；把心跳改回静态占位、恢复 120 秒上限、或让死流分支重新 `settleStream()`，都会立刻复发「全程静默」。心跳必须在 `lastPreviewText` 出现后让位。
26. **不得因为「新一代活跃了同一 peer」就取消未送达的 final 重试**（v150）：判据必须是「本次推送已有分片确认送达」。改回 `!supersededByNewInbound` 会让任何正常结束的回合在 20 秒重试窗口内被下一条消息销毁答案。
27. **不要移除 `sendPreviewUpdate` 排队分支里的 `stopPlaceholderKeepalive()`**：`req_id` 只有一个串行回执槽，占位保活会抢走排队进度帧的槽位，把它推向宽限截止（＝通道退休）。
28. **合并上游时不得机械接受 `package.json`**（v150）：`peerDependencies` 不得跟随上游收窄到 `^2026.7.0`（会挡掉 6.11 用户）；三个运行时依赖必须保持精确钉版（`reply.ts` 建模的是 SDK **1.0.7**）；`prepack` 的清 `dist` 步骤不得丢。逐条依据见第 2f 节的对照表。
29. **不得再用“返回后的 active run 是否存在”判定本次 flagless-zero 是否被接收**：它存在释放竞态，只可写日志；接收事实必须来自 `onAgentRunStart` / `onTurnAdopted`。未接收的 flagless 重试不得调用 drain，因为它也可能是 dedupe。
30. **不要让已成功经过 tracked `replyHandle.fail()` 的同一个 Bot WS 错误再次逃到 frame 边界**，否则 operational issue 会重复；但收口必须同时校验 transport、fail 已完成和错误对象同一性，不能吞不同或未处理异常。
31. **不要把 preamble 改回合成文案或同步投递**：真实文字必须来自 OpenClaw `onItemEvent`，只转发 `kind=preamble`；继续使用 detached progress lane，并让 final 经短屏障排在已接收的过程文字之后。

## 6. 已知边界与待办观察

- 群聊中「他人消息接管了正在运行的回合」时，旧回合收到的仍是「已收到新消息，合并思考。✅」，但跨成员并不合并内容——文案不够准确（既有问题，需要第三种提示语才能修）。
- 流仍然健康、但预览已冻结（>5 分钟或 >3000 字）时，冻结点之后的新正文仍要等到 final 才可见：后台推送只在通道退休/回执不可信时才启动。
- 一旦本轮出现过回执缺失，final 就固定走主动推送：答案以新消息到达，进度气泡停在最后一帧且不再收口。这是「宁可多一条消息，也不能静默丢答案」的既有取舍。
- 媒体在前仍保留 1 秒合并窗口，占位气泡已在窗口开始时显示。
- 群聊中不同成员的消息不合并内容；被顶掉的一方会收到「尚未开始处理」提示。
- 单条回合只有第一个附件成为 `MediaPath`。
- 释放等待上限 3 秒（中止被拒绝时），超时仍会拒收新指令，这是明确取舍。
- 单个 handoff/drain 最长等待 5 秒；只在存在 pending/active 冲突时触发。
- 被接管且「已可见」的旧 final 仍按 B3 丢弃，这是 B3 设计语义，不是 bug。
- ambiguous 补发存在有界重复风险（仅未确认分片、≤3 次）——刻意取舍。
- 若一轮内一次预览都没成功过且流在 120 秒内就死，占位保活会 `settleStream()` 并连带取消后台通知；此时答案仍以主动推送到达。窄场景，未处理。
- **真机（企微网关）验证仍未做**：`2.7.260-3` 发布后需重点观察 commentary/preamble 是否按 OpenClaw 原顺序显示、慢回执下是否只合并待投递快照，以及 60 秒辅助状态节拍。
- 发布 tarball 不入 git（*.tgz 未跟踪），以 changelog 打包记录的 shasum 为准。

## 7. 版本脉络备忘

`v118`（稳定基线）→ v119-135 开发线**未入主线** → `v136` 基于 v118 重建 → `v137` init-conflict 短重试 → `v138` 媒体+文字合并 → `v139` OpenClaw 7.1 适配 + 投递抗丢失 → `v140` 未发布体验包 → `v141` routed-final 收口 + SDK 1.0.7 → `v142` 进度/模型流解耦 → `v143` 暖会话 metadata 解阻塞 → `v144` 外部答案成功后的旧流静默结算 → `v145` retry/keepalive/注册表/source 生命周期闭环 → `v146` 入站即时确认、被接管消息并入、提示与事实对齐、7.1 冻结中止有界等待 → `v147` 回执缺失不再熄灭进度通道、错误 final 保留思考块、被接管失败文案不外泄、接管与中止同 tick 发布 → `v148` 失败长任务的推送带上耗时与框架、新增 `error-final` 诊断日志、长任务提示词改为请勿打断 → `v149` 文件/文字双向跨回合并入、长任务产出随后台提示一起送达、外部活动不再熄灭长任务反馈 → **`2.7.260-1`（原 v150）** 长任务反馈改为时间驱动、零产出回合不再全程静默；未送达的 final 重试不再被下一条消息销毁；合并上游并把版本基线推进到 2.7.260、构建号重新从 1 计数 → **`2.7.260-2`** 用接收回调消除完成态释放的 TOCTOU，并让同一个已处理 Bot WS 错误只记录一次 → **`2.7.260-3`** 恢复 OpenClaw preamble 真实过程文字，并将长任务辅助状态降到每分钟一次。

**版本号规则**：`<上游基线>-<构建号>`。构建号在**同一基线内**单调递增；**上游基线一变就从 1 重新计数**——`2.5.110` 基线走到 `2.5.110-149`，合并上游 `2.7.260` 后重新从 `2.7.260-1` 开始。tag 为 `released/<完整版本号>`，简报为 `changelog/v<完整版本号>.md`。
