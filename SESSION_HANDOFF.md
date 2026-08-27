# SESSION HANDOFF — OpenClaw WeCom 插件维护交接

> 最后更新：2026-08-27（`2.7.260-18` CLI 候选本地验收）。新会话开工前先读本文件、`README.md`、`changelog/README.md` 与最新版本简报。

## 1. 当前状态

- 当前候选版本：**`2.7.260-18`**，本地实现 `wecom-cli` tool、官方 16 个 Skills、启动预热和 MCP 的窄范围 CLI 兜底；全量 56 文件 / 706 用例、构建与 B1/B2/B3 门禁已通过。依赖固定为 `@wecom/cli@1.2.0`，自测 OpenClaw 固定 `2026.7.1-2`；尚未打发布 tag 或推送远端。候选包已做隔离安装审计，最终 tag 包指纹待 tag 后补记。
- 当前正式版本：**`2.7.260-17`**，发布标签 `released/2.7.260-17`。`wecom_mcp` 收口发布版，现网按 `bot.mcpServers` 配置**验证通过**。`851003` 的根因是结构性的：`aibot_get_mcp_config` 签发 `/mcp/robot-doc`「企微机器人文档 MCP」（只有机器人自身作用域），后台 apikey 签发 `/mcp/v2/bot/<biz>`「动态文档 MCP」（内嵌授权真人用户）。详见第 2u 节。
- `2.7.260-15` / `-16` 是未打 tag 的验证版，内容已并入 `-17`——`-14` 冒烟失败后的收口，等真机验证通过再发布，详见第 2t 节。
- 当前正式版本：**`2.7.260-14`**，发布标签 `released/2.7.260-14`，包 `yanhaidao-wecom-2.7.260-14.tgz`（打包指纹见 `changelog/v2.7.260-14.md`）。`wecom_mcp` 严格对齐官方实现，补上缺失的请求身份 header（`851003` 的真正根因）与文档授权引导卡片。详见第 2s 节。
- 上一正式版本：`2.7.260-13`，包 `yanhaidao-wecom-2.7.260-13.tgz`（240,025 bytes；SHA-256 `b0a4ccf73473d9177f2c351a17586e088ced131e5bb12be1e3be5edbe272f9e4`）。其根因判断已被 `-14` 更正，详见第 2r/2s 节。
- 更早正式版本：`2.7.260-12`，包 `yanhaidao-wecom-2.7.260-12.tgz`（236,216 bytes；npm shasum `bcd10ebb98df44d1a363b76492f28a3fdba78719`；SHA-256 `bd0a8330534b27d636df463f1fed8539cb8b91ce9c59972ebbe3115a78f42ac3`）。上游核查、断连事件与 `chat_type`，详见第 2q 节。
- 更早正式版本：`2.7.260-11`，包 `yanhaidao-wecom-2.7.260-11.tgz`（234,268 bytes；npm shasum `e14aa513c4717bfbe2120ac131a0a46e4309ec76`；SHA-256 `b84d65db6d007ef1bb512e11aa616f7148aca74e5eb1e97b42b4fb1546a5dee7`）。思考块 wire 安全化与长任务过程收口，详见第 2p 节。
- 更早正式版本：`2.7.260-10`，包 `yanhaidao-wecom-2.7.260-10.tgz`（npm shasum `0782f45f28a70be108bd626fbe05eff9f3fc6b27`）。过程＝追加式步骤日志，详见第 2o 节（其中「📋 本轮过程记录」推送已在 `-11` 取消）。
- `2.7.260-3` 是**已撤回的历史候选**：本地与 `fork` 上的 tag、对应 tarball 均已删除，历史提交保留且不重写；由 `2.7.260-4` 替代。上一有效正式版本为 `2.7.260-2`，发布标签 `released/2.7.260-2`。
- v149 修复「文件+文字互相丢一半」「长任务产出被后台提示丢弃」「一次主动推送永久熄灭长任务反馈」，见第 2c 节；v148 修复「失败长任务只剩一行 `LLM request failed`」并优化长任务提示词，见第 2b 节；v147 修复现网反馈的三类问题（莫名失败提示、长任务无过程信息、思考块经常不出现）。
- 当前及后续自测统一固定为 OpenClaw **2026.7.1-2**，仓库 devDependency 使用精确版本；不再运行其他版本或双版本矩阵。`peerDependencies` 仍保留 `^2026.6.11` 安装兼容范围（见第 2f 节），只表示安装兼容声明。
- 企业微信 Bot SDK：`@wecom/aibot-node-sdk` **1.0.7**（固定版本）。**2026-08-25 核查：1.0.7 仍是 latest（2026-05-12 发布），无新版本可升**；官方自家插件依赖 `^1.0.6`，解析结果同样是 1.0.7。
- 远端纪律：**只推 `fork`（git@github.com:liny90626/wecom.git），绝不推 `origin`（上游 YanHaidao）**；从 `origin` **拉取/合并**是允许且必要的（见第 2f 节），禁止的只有推送；提交邮箱固化为 `liny90626@users.noreply.github.com`（GH007 教训）。
- `2.7.260-14` 发布验证：只用 OpenClaw 2026.7.1-2，全量 **48 文件 / 639 测试全绿**；build/typecheck/dist/B1/B2/B3/diff-check 全绿。`wecom_mcp` 用例按官方语义重写为 21 条，另加 `PLUGIN_VERSION` 对账 1 条；**敏感性验证 9 条**分两轮转红后恢复。
- `2.7.260-13` 发布验证：只用 OpenClaw 2026.7.1-2，全量 **47 文件 / 645 测试全绿**（机器已空闲，load average 2）；build/typecheck/dist/B1/B2/B3/diff-check 全绿。`src/capability/mcp/` 此前零测试覆盖，本轮补 28 条；**敏感性验证 4 项**（去归一 / 去重试 / 去限幅 / 去脱敏）逐条转红后恢复。
- 补记：`2.7.260-12` 当时无法在负载机上转绿的 `gateway-sim`「carries real narration」，在空闲机器上随全量套件一次通过——当时判定的「环境问题、非回归」成立。
- `2.7.260-12` 发布验证：只用 OpenClaw 2026.7.1-2，全量 46 文件 / **617 测试**：并发受限的一轮 616/617，唯一失败是 `gateway-sim` 的「carries real narration」超时（30 秒预算，同一份代码连跑得到 22.8s 过 / 30.4s / 31.2s / 34.4s 超时，基线同为 26.6s——机器问题，**没有为此调高 timeout**），该用例单独复跑通过。build/typecheck/dist/B1/B2/B3/diff-check 全绿。新增 5 条用例（另有 17 处既有推送断言随上线帧形态更新）；G1 的两条断言与 G3 的端到端断言均**先变红后修复**——端到端那条抓出「push handle 之外还有 `sendViaClient` 回落」，全量套件又抓出「事件回复的两条分支仍在让服务端猜」；敏感性验证通过（移除 `chat_type` 映射即转红）。
- **测试机负载警告**：本轮全量套件在 load average 55–65（8 核）下出现 3–5 条**超时/性能预算类**抖动（`Test timed out in 5000ms`、`expected 2643ms to be less than 1000`），两次失败集合互不相同，隔离复跑全绿。判定失败前先看断言类型与 `uptime`：**超时与耗时预算 ≠ 回归**。
- `2.7.260-11` 发布验证：只用 OpenClaw 2026.7.1-2，全量 46 文件 / **612 测试全绿**；build/typecheck/dist/B1/B2/B3/diff-check 全绿。`process-record.test.ts` 重写并更名为 `long-task-progress.test.ts`（6 条）；**敏感性验证 9 项**逐条转红后恢复，其中两项在走查阶段抓出本轮自身缺陷（无日志帧未清空气泡账本→永久丢步；心跳不重置沉默时钟→1002 帧空转）。
- `2.7.260-10` 发布验证：只用 OpenClaw 2026.7.1-2，全量 46 文件 / **597 测试全绿**；build/typecheck/dist/B1/B2/B3/diff-check 全绿。新增 `process-record.test.ts`（5 条真实链路回归），orchestrator 用例改写为日志语义；两项敏感性验证（去掉落档挂钩、还原 latest-wins）均转红后恢复。
- `2.7.260-9` 发布验证：只用 OpenClaw 2026.7.1-2，全量 45 文件 / **592 测试全绿**；build/typecheck/dist/B1/B2/B3/diff-check 全绿。相对 v7 的 594：新增 4 条（两条根因复现、一条端到端工具密集回合、一条 deferred 工具回合回归），删除 9 条**只为已删除功能存在**的用例，保留行为的断言未削弱。
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

## 2h. `2.7.260-3`：已撤回的历史候选

> 本节仅保留历史背景。`released/2.7.260-3` 与对应 tarball 已撤回；当前行为以第 2i 节的 `2.7.260-4` 为准。

### ① OpenClaw 有过程文字，但企微只显示插件提示

根因在插件与 OpenClaw 的接缝：`dispatchRuntimeReply` 只订阅 reasoning、block 和少量 Fast 状态，没有订阅 6.11/7.1 已提供的 `onItemEvent`。OpenClaw 产生的 commentary/preamble 因此在插件入口前直接丢失；当 reasoning 默认关闭、长任务又主要由工具组成时，用户看到的就只剩插件按时间生成的辅助状态。旧实现接入真实 dispatcher 的复现探针明确报出 `params.replyOptions.onItemEvent is not a function`。

修复使用 OpenClaw 自带的渠道进度契约，而非合成过程文字：

- 开启 `commentaryProgressEnabled` 与 `suppressDefaultToolProgressMessages`，让渠道接收结构化 item 事件并避免 OpenClaw 默认工具摘要与渠道进度重复。
- `onItemEvent` 只转发 `kind === "preamble"` 的真实过程文字；命令执行、审批、工具状态等内部事件不冒充正文。
- 同一 item 的累计快照原位更新，不同 item 按首次出现顺序合并；没有 `itemId` 的事件仍保持发生顺序。慢 ACK 时只保留最新待投递快照，避免旧快照排成长队。
- 复用既有 detached progress lane，回调不等待企业微信网络；回合结束时仍使用 500ms 短屏障，保证 final 不越过已经收到的过程文字，又不让坏 ACK 长时间拖住答案。

### ② 长任务辅助状态过于频繁且文案太长

冻结预览与静默任务状态过去每 15 秒刷新一次。旧版网关模拟中，冻结气泡在 59 秒内从 1 帧增长到 5 帧，且每帧都携带很长的「请勿打断」文案。现在共用的刷新间隔改为 60 秒，状态缩短为 `【任务处理中，已用时 1m30s】`。满 30 秒的首次状态、入站后 3 秒占位确认、真实过程一到立即让位、9 分钟后台兜底和最终正文投递均保持原契约。

## 2i. `2.7.260-4`：瞬态过程、长任务节奏与最终 wire 同源

### ① 长任务状态统一到绝对 8 分钟

- 首次状态严格以回合开始时间计算，在绝对 **8 分钟**出现，文案为 `【长任务处理中，请勿打断，已用时8m00s】`；随后每 **15 秒**刷新。
- 静默任务、冻结正文预览、死流或持续丢 ACK 后的主动推送共享门槛和 cadence；成功 placeholder 只发一次，只有失败保留 3 秒短重试。
- pending preview、in-flight ACK 和真实进度拥有单一 ACK 槽优先权，状态帧不会抢槽。
- 单独跟踪“长任务状态是否已显示”，因此 `7m59s` 才送达的冻结预览不会把首状态推迟到 `8m15s`。
- 8 分钟状态帧持续丢 ACK 时，确认不可信后切既有 active-push cadence；后续 preview 恢复会完整解除后台 armed 状态，外部活动不能重新制造双路状态。

### ② preamble 是当前快照，不是增量正文

- `dispatchRuntimeReply` 只接收 `onItemEvent(kind="preamble")`，并标记 `channelData.openclawProgressKind="preamble"`。
- 同一 item 的 `progressText` 原位替换，不把缩短快照追加到旧值；不同 item 按首次出现顺序组合，无 `itemId` 使用匿名 item。
- 慢 ACK 时只保留最新待发槽，并在出队时懒构造完整快照；10,000 item 性能回归避免 O(n²) 式重复拼接。
- preamble 不进入 `accumulatedText` 或 final；preamble-only 不算已显示真实正文，因此不得抑制 superseded 回合的真实 final。

### ③ 预算必须针对最终 wire，书签必须来自同一候选

P1 红测稳定复现：400 个 literal `` `<think>` `` 先按 Markdown 文本截到近 3500 字符，再转义成 `&lt;think&gt;` 后，最终实际发送达到 **5551 字符**。普通预览、normal final 和 active push 都存在相同的“先分段、后扩张”根因。

现在统一先完成 Markdown 规范化、literal think 转义、真实 thinking block 和 completion marker，再按最终企微 wire 执行字符/UTF-8 字节分段。预览 helper 同时返回生成该 wire 的实际 source prefix，调用方不再从转义前文本反推书签。

独立红测进一步证明并修复了这些同源缺陷：

- 大 preamble 或 Fast 状态整帧覆盖正文后，旧书签过长会使 846608 fallback 永久漏掉被覆盖片段。
- preamble-only / Fast-only 曾错误设置“正文已可见”，导致新消息接管后真实 final 被静默丢弃。
- error final 的 thinking 前缀曾按 3500 而非 final 的 2000 字符预算，`finish=true` 帧可越界。
- completion marker 可能位于分段编号之前、正文自带 marker 时重复，或 reasoning-only 收口成为空帧。

### ④ 当前验证边界

仅在生产同版本 OpenClaw **2026.7.1** 验证：全量 44 文件 / 541 测试，核心 4 文件 / 264 测试，以及 typecheck、build、dist、B1/B2/B3、diff-check 均通过。未做 2026.6.11 切换测试，未做真机企业微信网关验证，未执行 `npm publish`。

## 2j. `2.7.260-5`：结构化真实进度与动态回调所有权

### ① 长任务为什么仍只有插件提示，没有 OpenClaw 过程

`2.7.260-4` 已恢复 preamble，但 OpenClaw 2026.7.1-2 的 item/tool/command/plan/approval/patch/compaction 生命周期走另一组结构化回调。旧插件没有把这些事件接入 detached progress lane，所以真实 dispatcher 在执行工具后失败时，企微只收到 failure final，看不到已经发生的 `Exec: running`。

现在复用 OpenClaw 官方 channel progress formatter，最多维护 4 行受控快照。只接受已知类别、工具名和状态；命令文本、参数、路径、搜索词、审批内容与工具返回值都不转发，未知名称降级为 `tool_call` / `api`。正文、reasoning、preamble、结构化进度与 Fast 分开记账，瞬态过程不冒充正文、不进入 final；长任务心跳会把最新真实过程与计时一起保留。过滤掉的普通 tool result 仍不算有效产出，fallback-eligible zero-output 语义不变。

红/绿证据：对 `109c72e` 的原生产 blob 运行真实 dispatcher，只得到 failure final；当前候选会先送出净化后的结构化过程。对应回归覆盖真实 dispatcher、item、tool fallback、command、plan、approval、patch、compaction，以及流窗口失效后继续主动推送新过程。

### ② 文件+文字为什么会把相邻气泡覆盖掉

企微 SDK 为每个 `req_id` 建立一条回调队列，ACK 也只按 `req_id` 匹配。旧适配器默认该值唯一：相邻消息复用同一值时，后一个 handle 继续写前一气泡；若前一帧超时后的 ACK 迟到，还会结算同 `req_id` 的新队首并永久吞掉前一条内容。文件+文字的 1 秒合并窗口放大了这个时序，但根因是回调 lane 没有 owner，不是合并规则本身。

现在每个 `req_id` 用 `messageId + ownerToken` 认领 8 分钟。同一值只能有一个当前 owner；冲突、原消息重投、缺失 ID、认领表满，以及 TTL 到期但 SDK 仍有 pending ACK 时全部 fail closed 到 active push。容量满时只清过期项，不驱逐活跃认领。所有权丢失永久锁存，progress、heartbeat、final、failure、welcome 和 pending-ACK 等待后都会复查；final 去重也加入 owner generation，避免不同 owner 的相同正文互相吞掉。

网关模拟同步改成真实 SDK 语义：迟到 ACK 结算当前同 `req_id` 队首。新增跨层集成测试覆盖文件后文字、丢 ACK 后接管、唯一 `req_id`、复用 `req_id` 与复用值遇到 6 秒迟到 ACK。原生产实现会覆盖或永久丢失前一条，候选保留两条可见回复。

### ③ 同源加固与验证边界

- thinking 与冻结预览的 UTF-16 裁剪不再切断 emoji 代理对。
- 瞬态过程书签和正文书签独立；流死亡后新过程仍可随后台状态投递，晚预览不能在 owner 丢失后推进正文书签。
- 只用 OpenClaw **2026.7.1-2**：全量 45 文件 / 592 测试，核心 6 文件 / 368 测试，以及 typecheck、build、dist、B1/B2/B3、diff-check 全部通过。
- `npm audit --omit=dev` 仍有 `undici@7.28.0` 的 1 个 high 告警，修复版本为 7.29.0；本轮未扩展依赖升级范围。
- 未做真实企微网关/客户端验证，未执行 `npm publish`。

## 2k. `2.7.260-6`：跨 item preamble 精确去重

### ① 为什么同一句过程文字会出现两次

OpenClaw 2026.7.1-2 会在单个 commentary item 内累计并抑制未变化的文本，但去重范围以 `itemId` 为界；两个不同 item 仍可携带完全相同的当前快照。插件原来把 `preambleItemOrder` 中每个 item 的文本直接按首次出现顺序用换行连接，只处理同一 item 的替换，不处理跨 item 的相同可见值。因此一次过程气泡会确定性变成 `文本\n文本`。最终答复出现时过程被清理，是瞬态 preamble 不进入 final 的既有设计，与重复根因无关。

### ② 修复边界

- `resolvePreamblePayload` 构造可见快照时使用本次快照级 `Set<string>`，按完整文本精确去重，保留第一次出现的 item 顺序。
- item 状态仍完整保留在 `preambleTextByItem`；第二个 item 后续更新为不同文本时，会按原顺序重新出现在快照中。
- 不做 trim 之外的归一化，不做模糊或语义去重，避免吞掉措辞相同但确属不同步骤的过程。
- 不把 preamble 放入 `<think>`；reasoning、结构化进度、正文书签、final 组成与 Bot WS 传输行为均未改动。
- 成功 final 继续清理瞬态过程，只显示最终正文；没有 final 时仍保留最后一次可见过程，避免气泡被清空。

### ③ 红绿证据与发布边界

旧实现的定向回归实际收到第二帧 `正在评估终止风险\n正在评估终止风险`；生产修改后同一用例转绿，并验证重复 item 后续改为 `终止风险评估完成` 时快照正常变为两条不同文本。只用 OpenClaw **2026.7.1-2**：全量 45 文件 / 593 测试，核心 6 文件 / 369 测试，以及 typecheck、build、dist、B1/B2/B3、diff-check 全部通过。未做真实企微网关/客户端验证，未执行 `npm publish`。

## 2l. `2.7.260-7`：最终瞬态气泡按可见行统一去重

### ① 为什么 v6 后仍然重复

v6 在 orchestrator 的 `resolvePreamblePayload` 中按“每个 item 的完整字符串”去重，假设重复只会表现为两个 item 的整段值完全相同。用户实测证明该假设不成立：一个当前快照本身可能包含重复行，两个快照也可能只有局部内容重叠；结构化事件虽然身份不同，但命令和参数被隐私过滤后可能同时渲染成相同的 `🧰 Tool Call` / `🛠 Exec`。这些值进入 `reply.ts` 后按类别直接拼接，因此 v6 的整段级 `Set` 无法消除最终气泡里的重复可见行。

### ② 修复位置与语义

- `composeTransientProgressSnapshot` 在 Bot WS 最终瞬态快照层遍历 preamble、structured-item 和 Fast 的当前值，按换行展平，trim 后用本次快照级 `Set<string>` 精确去重，再按类别重新组成气泡。
- 去重保留第一次出现的顺序，不做包含、编辑距离或语义相似度判断；不同文本仍全部保留。
- 每个过程类别的原始当前快照仍保留在 `transientProgressTextByKind`，每次更新都从当前状态重新计算。因此后续新增或变化的行可以出现，已经从所有当前快照消失的行也会消失。
- 流式气泡、流窗口失效后的循环状态、强制主动推送共用 `latestTransientProgressText`，不再各自保留不同的重复行为。
- 多次真实工具调用若脱敏后成为完全相同的通用标签，只显示一行；这些行不含可区分信息，重复展示没有额外用户价值。这是明确的展示层取舍，不影响工具执行或日志。
- 正文、reasoning、preamble 源状态、正文/瞬态书签、ACK、final 与媒体路径均未修改；成功 final 仍只保留最终答复。

### ③ 红绿证据与发布边界

新增测试直接构造用户反馈形态：preamble 包含两条完全相同的长句，随后 structured-item 包含两组 `Tool Call / Exec`。旧实现第一帧明确保留重复长句；修复后自然语言和工具标签均只出现一次，后续新增“整改方案已生成”仍能显示，final 中不含任何瞬态过程。只用 OpenClaw **2026.7.1-2**：全量 45 文件 / 594 测试，核心 6 文件 / 370 测试，以及 typecheck、build、dist、B1/B2/B3、diff-check 全部通过。未做真实企微网关/客户端验证，未执行 `npm publish`。

## 2m. `2.7.260-8`：删掉工具提示通道，过程文字回到「当前步骤」

现网反馈两条：**①长任务和短任务过程中都会出现 tool call 等工具调用提示；②重复的文字段落，v5~v7 都没治好。** 并要求复查 v118 → 当前的冗余代码，「所有代码都是解决根因而存在的，而不是不停地通过加保护牺牲了稳定性与速度」。

### ① 工具提示：这条通道结构上不可能有信息量

v5 为了让长任务显示真实过程，接了 7 个 lifecycle 回调（`onToolStart` / `onCommandOutput` / `onPlanUpdate` / `onApprovalEvent` / `onPatchSummary` / `onCompactionStart` / `onCompactionEnd`）+ 非 preamble 的 `onItemEvent`，再喂进 OpenClaw 官方 progress formatter。但**禁改 35 要求命令、参数、路径、搜索词、审批内容、工具返回值全部不可外发，工具名也要降级成白名单通用值**。实测把真实事件喂进 formatter，输出只有 `🧰 Tool Call: running` / `🛠️ Exec`。

也就是说，脱敏之后这条通道只能表达「有个工具在跑」——而 8 分钟长任务心跳已经在说同一件事，且不占正文预算。**整条删除**（7 个回调、三张归一化表、`structured-item` 载荷类型，以及 `reply.ts` / `reply-visibility.ts` 的对应分支）。

**唯一保留**：`onToolStart` 仍订阅，但只置 `runActivityObserved`，不产生任何投递。删掉它会让「只跑工具、无可见输出、被判 deferred」的回合退化成空回合并回 `WeComReplyNoVisibleOutputError`——已用定向用例复现（去掉这 3 行 → 用例直接抛错）。这是分诊需要的事实证据，不是保护。未知/内部 item kind 仍不算证据（既有 `it.each` 用例守着）。

### ② 重复段落：把「当前步骤」当成了「清单」

OpenClaw CLI 后端 `execute.runtime` 的 `emitCliCommentaryText` 用自增计数器发 commentary：

```js
let commentaryCounter = 0;
const emitCliCommentaryText = (text) => {
  commentaryCounter += 1;
  emitAgentEvent({ stream: "item", data: {
    kind: "preamble", itemId: `commentary-${params.runId}-${commentaryCounter}`, progressText: transformedText,
  }});
};
```

触发点是 `claude-live-session` 里 `content_block_start` 遇到 `tool_use` ⇒ **每调一次工具，工具之前那段自述就被 flush 成一条新 commentary，`itemId` 每次都变**。插件却把 `preambleItemOrder` 里所有 item 的文本换行拼接，于是调 6 次工具就叠 6 段自述。模型跨步骤自述天然相似但并不相同，**v6 的整段 `Set` 和 v7 的按行 `Set` 都吃不掉**。

**这不只是难看**：气泡按 `composePreviewSuffixWithinLimits(prefix=正文, suffix=过程)` 合成，**suffix 先按全额预算渲染，正文只拿剩下的**，所以自述越堆，用户能看到的答案正文被截得越短。

修复：`preambleTextByItem` / `preambleItemOrder` / `anonymousPreambleItem` 合并成一个 `currentPreambleText`，最新值覆盖，文本没变不发帧；`itemId` 不再参与判定。v6、v7 两层去重一并删除（根因消失后它们只是对模型原文的多余改写）。`reply.ts` 里 preamble 与 fast-mode 两个完全相同的分支也合并成一个。

### ③ 对速度/稳定性的实际影响

企微 SDK 每个 `req_id` 只有**一个串行回执槽**，final 发送前要等 `waitForPendingReplyAckToClear`（最长 5.5s）。过程帧越少，final 撞上待回执的概率越低——**这是直接的答复提速**。6 步工具回合的过程帧由「每个 lifecycle 边沿都可能推（18 个事件）」降到「仅自述变化时推（≤6 帧）」，端到端用例已固化上界。

### ④ 冗余复查结论（v118 → v8）

- reply.ts / reply-orchestrator.ts 用脚本扫过：**没有零引用的顶层符号或闭包**，累积的不是死代码而是活机制。
- `dedupeLongFinalText` / `findRepeatedHeadingTail`（约 130 行最终文本去重启发式）**在 v118 里就存在**，属稳定基线，本轮未动。
- 心跳（`placeholderKeepalive`）、冻结状态（`previewStatusInterval`）、后台推送（`previewExpiredNotice`）三条长任务反馈看似重复，实为**三种不同传输条件**下的同一语义（气泡未渲染 / 气泡已冻结 / 气泡不可用），且分别由禁改 25、27、34 锁定，本轮判定为必要，未合并。
- 上游 `YanHaidao/wecom` 有新提交（markdown 子集拆分、多分片节流、agent-api 重构等），**本轮未合并**：不在本次任务范围内，且会污染本次改动的验证信号。

## 2n. `2.7.260-9`：长任务状态的唯一时钟

现网反馈：状态刷新「有的时候 15s，有的时候只有 2s，有的时候甚至重复会刷新」，并要求间隔改为 1 分钟。

### ① 根因不是间隔值，是没有唯一时钟

这条状态有**三个绘制者**：气泡心跳 `placeholderKeepalive`（气泡尚未渲染过内容）、冻结刷新 `previewStatusInterval`（正文已冻结）、后台推送 `previewExpiredNotice`（气泡不可重绘）。三者各持一个定时器，**相位由最近一次碰它的无关事件决定**——一帧过程文字会 `pausePlaceholderHeartbeat` 后重排，一次外部推送会顺延，一次回执缺失会当场挂载推送通道。

用网关模拟器逐秒采样 12 分钟（只统计**用户实际可见**的气泡修订与推送），修复前实测：

- 丢一次状态帧回执：`480s bubble 8m00s` → `485s push 8m05s`，**同一句状态、两条通道、相隔 5 秒**。
- 过程文字每 37 秒到达：`gaps = [17,15,22,15,22,15,22,...]`。
- 中途一次外部消息：`gaps = [15,20,15,15,15,21,...]`。

### ② 排查中发现的三处独立时序缺陷

1. 刚过 8 分钟门槛的一帧过程文字**不消耗状态名额**，状态帧紧随其后 **1.6 秒**发出（＝反馈里的「2s」）。
2. 名额用**帧的合成时刻**盖章而非**确认送达时刻**；慢回执下合成时刻可能还在门槛前，名额看起来从未被占用。
3. 到期时间已过时，心跳以 **0 延迟**反复重排（忙循环），且触发时不复查时钟就直接绘制。

### ③ 修复：绝对网格 + 名额语义

- 第一格在回合开始后绝对 8 分钟，其后每 `LONG_TASK_STATUS_INTERVAL_MS`（**60s**）一格；`nextLongTaskStatusDueAt()` **吸附到网格**，一次迟到的绘制不拖后后续格子。
- 三条通道绘制前查 `isLongTaskStatusDue()`，绘制后调 `markLongTaskStatusPainted()`；心跳在**定时器触发时再查一次**（排队期间名额可能已被真实产出用掉）。
- **任何一次确认送达的重绘都消耗名额**，不只是字面带状态行的：状态只表示「还在跑」，新鲜过程文字是更强的证明。正文持续流动时状态自然不出现。
- **名额在发出时占用，只在证明未送达时归还**：846605/846608 是企微明确拒绝 ⇒ 归还，让推送立即补位；**回执缺失不算证据**（网关多半已渲染），保留占用——「归还」正是 5 秒重复的来源。
- 心跳新增「本次是否真的发出」返回值：被占用时按 `PLACEHOLDER_RETRY_MS` 退避，不再 0 延迟空转。
- 冻结刷新那条固定相位的 `setInterval` 换成从时钟重排的 `setTimeout`（旧实现会发出被节流丢弃的空转 tick）。
- 删除 `BLOCK_PREVIEW_STATUS_UPDATE_MS`、`PREVIEW_EXPIRED_NOTICE_REPEAT_MS`、`lastPreviewStatusAt`、`longTaskStatusStarted`。

### ④ 修复后实测与取舍

六种场景（静默／正文冻结／状态帧丢回执／过程文字错拍／外部消息／流窗口失效）全部 `gaps = [60,60,60]`，对齐 `8m00s · 9m00s · 10m00s · 11m00s`，且**每格只有一条通道绘制**。

**取舍**：状态帧丢回执时，首条状态推迟到下一格（最多 60 秒）。企微多半已经渲染了那一帧，立刻补推就是用户反馈的重复；明确被拒绝的帧仍由推送立即补位。

## 2o. `2.7.260-10`：过程 = 追加式步骤日志（记录，不是状态）

### ① 现网反馈与复现

> 长任务中（8 分钟以内），虽然可以看到消息在刷，但每一条消息都是在 agent 发送的原气泡上覆盖刷写，长任务的过程依旧没有正确记录和回复。

网关模拟复现（4 分钟 4 步骤，逐帧采样）：每帧只有「当前步骤」（出现第 2 步的帧里第 1 步已消失）；final 后气泡只剩答案；全程零推送——过程在最终聊天状态里**零残留**。

### ② 根因是类别错误

产线 OpenClaw 2026.7.1-2 bundle 源码确认：`claude-live-session` 把增量文本缓冲在 `pendingClaudeText`，遇 `tool_use` 即 flush 成一条**新** commentary item（`commentary-<runId>-<n>` 自增、**一次性发射后不再更新**）；非 tool 的 `content_block_start`/`message_stop`/`result` 才 flush 成正文。一轮工具任务的自述天然是「有序段落序列」＝日志。插件却建模成**可变状态**（v8：只存当前步骤；传输层每帧整帧覆盖；final 不含过程）。v4 快照、v5 结构化通道、v6/v7 两层去重、v8 当前步骤——五轮都在调「状态怎么刷」，没人改「它是状态还是记录」。

### ③ 修复

**orchestrator（源语义步骤边界，不是展示层去重）**：`preambleSteps[]` 一条 item＝一步；同 item 更新原位替换；相邻新 item **同文**合并为一步且**不承接新 id**（该 item 后续分化→新步骤，不改写历史——保住 v6「重复后分化为两条」）；相邻新 item **前缀延续**原位延长并承接 id；非相邻真实重复**保留**。上限 `PREAMBLE_LOG_MAX_STEPS`（200），溢出丢最早并计数。完整日志随 `channelData.openclawProgressSteps`/`openclawProgressDroppedSteps` 下行（无 steps 的直连载荷降级为单步日志＝旧语义）。

**传输层（一个 durable 前缀书签）**：
- 气泡＝活视图：`1）2）…` 编号追加（全角括号避开 markdown 有序列表自动重编号），尾部窗口按**字符+字节双预算**从最新往前装填，装不下时首行「…（已省略前 N 步）」。正文在场时日志限 `PROCESS_LOG_TAIL_WITH_BODY_MAX_CHARS`（800 字符）——v8 答案预算修复不回归。心跳帧先为状态行**预留预算**再装日志（禁改 25）。
- 推送＝持久化：冻结/死流状态推送与 owner 丢失强推都从 `processLogDurable` 起送**增量**，确认送达才 `advanceProcessLogBookmark`（禁改 23 语义）；`clampProcessLogBookmark` 让被改写的尾步重新可送。每步恰好持久化一次；死流转推送瞬间首条推送会带上气泡展示过的步骤（durable 补齐语义，编号自明）。
- final 后落档：`maybeFlushProcessRecordPush` 挂在 deliver() final 尾部、final 重试成功、fail 通道三处；门槛 `PROCESS_RECORD_MIN_TASK_MS`（2 分钟）且 ≥2 步；superseded/isEvent 不落档；失败仅告警不重试；一次回合最多一条。
- 配套删除旧「当前值＋字符串等值」记账：`latestTransientProgressText`、`transientProgressTextByKind`、`lastDeliveredTransientProgressText`、元数据 `transientProgressText`。Fast 横幅仍是独立当前值 lane（`pushedFastModeText` 防重推）。

### ④ 验证与敏感性

新增 `process-record.test.ts` 5 条真实链路回归（orchestrator→handle→sim）：4 分钟追加+落档、<2 分钟不落档、v6 同文一步化+分化新步、前缀延续合并、死流增量持久化零重复。orchestrator 用例改写为日志语义（每帧是日志前缀、无重复行）；10,000 item 性能回归在 200 步上限下 354ms。敏感性：去掉落档挂钩→「期望 1 条推送、实际 0 条」；还原 latest-wins→4/5 转红。全量 46 文件 / 597 全绿。

## 2p. `2.7.260-11`：思考块的两处失效、长任务过程收口、上限放大、工具阶段假死

### ① 思考块吞掉答案（现网：「气泡里只有思考块，没有答案」）

**先证伪了两个假设**：尺寸（四种形态逐帧实测，全部在 3500 字符/12000 字节内，也远低于官方 20480 字节）、CPU（`mergeReplyText` 单次最长阻塞 15ms；微基准 16k 段 120 次合并 9ms）。

**根因**：思考块是**唯一没经过正文归一化就上线的文本**——只做 `/<[^>\n]*>/g`（删同一行内成对标签），裸 `<` 原样送出；而块尾**一定有 `</think>`**，客户端便把 `< … </think>` 当成一个标签吃掉，块不闭合并连答案一起吞没。被截断的代码围栏同理。这解释了「为什么只有思考块中招」：正文里的裸 `<` 没有那个「保证存在的 `>`」。

**修复**：`escapeThinkBlockText` 改为 `toWeComMarkdownV2(text, null).replace(/</g, "&lt;")`（转义会膨胀，必须在预算之前，禁改 32 顺序不变）；`stripDanglingThinkMarkup` 同时处理半截实体与**所有**残留 ``` （归一化后还活着的围栏按定义无配对）。

**复现方式**：跑不了企微客户端，所以把复现降到可观察的一层——断言「`<think>` 内不得留下能吞掉后续内容的悬挂结构」，旧代码在 4 种真实推理形态里稳定报红 2 条。

### ② 思考块过长导致气泡卡死（现网：「输出到一定长度就再也收不到消息」）

**复现**：六次累计推理快照只发出 **2 帧**。**根因**：思考块按**头部**截断，越过上限后每帧逐字节相同 → `previewText === lastPreviewText` 等值判定丢帧 → **整条预览通道静音**。

**修复**：改为**尾部窗口**（显示最新一段，首行 `…（较早的思考已省略）`）。代理对在**头尾都不得劈开**（`sliceUtf16SafeSuffix` / `trimToUtf8BytesFromEnd`）。渲染只对能装下的窗口做，成本与推理总长解耦；节流判断挪到合成之前（推理是累计快照、每秒几十次，过去每帧都归一化整段再丢掉，占的正是回执等待的线程）。

### ③ 思考块与正文共用同一帧预算

`resolveThinkingAwareBodyLimits` 从同一帧的 3500 字符 / 12000 字节里**先扣思考块**，3000 字符思考块把正文预览压到 **484 字符**。现在正文在场时思考块收紧到 **800 字符 / 2400 字节**（与过程日志同规矩），并把「渲染好的块」与「正文预算」合并为一次 `resolveThinkingFrameLayout` 产出——此前两处分别计算，存在算不到一起去的结构性风险。

### ④ 长任务过程：补盲区、去重复、取消记录推送

15 分钟 / 22 步 / 6 分钟流窗复现：05:35–08:00 完全无反馈；首推重发 1–10 步；收尾「📋 共 22 步」只列 2 步。

- **盲区自造**：流窗约 6 分钟死亡，推送闸门却写「回合满 8 分钟」。现在流窗一死**推送立刻接手**（下限 `handleStartedAt + BLOCK_PREVIEW_MAX_MS`，防止早期异常拒绝把年轻回合变成推送会话）；**纯状态推送仍守 8 分钟绝对门槛**。
- **首推重复**：被企微拒绝（846605/846608）的那一帧再也无人能覆盖（final 也不行）＝已是永久聊天记录，其已确认步骤前缀并入**同一个** `processLogDurable`（不是第二个书签）。走查补上两个反例：一帧**不含日志**的正文预览/冻结状态会整条覆盖气泡 ⇒ 那份「已展示」立即作废；被 wire 合成器裁掉尾部的视图 ⇒ 一律不认账。
- **取消 `maybeFlushProcessRecordPush`**：长任务过程本就随进行中的推送逐条落档，收尾只发答案。
- **节奏**：有新内容按 60 秒网格推；无新内容的状态推送要先静默 `LONG_TASK_QUIET_STATUS_INTERVAL_MS`（5 分钟）。

### ⑤ 消息上限放大到官方额度约 75%

官方 stream `content` 上限 **20480 字节**（本轮从官方文档核实）。`12000` 的来历是 `v2.5.110-112` 的「避免盲目放宽限制引入客户端截断」——不知道官方数字时的保守猜测，仓库无任何实测支撑。现：答案每段 2000→**5000 字符**、帧字节 12000→**15360**。实测 6000 字答案 4 条→2 条、10000 字 6 条→3 条。**预览帧 3500 与冻结阈值 3000 刻意不动**（放大它们直接加重回执槽压力）。

### ⑥ 工具阶段气泡假死

`scheduleHeartbeat` 把下一次心跳**直接排到第 8 分钟**，`sendPlaceholder` 又在有预览时提前返回——「思考结束、工具跑很久」这段静止是代码层面安排好的。**可见性与「长任务」拆成两个触发器**：「请勿打断」仍守 8 分钟绝对门槛；「还活着」由沉默驱动——运行侧报告工具活动后（`markRunActivity`，来自既有的 `onToolStart`，仍不产生任何可见文字），气泡静默满 `PREVIEW_SILENCE_MAX_MS`（90 秒）即重绘完整帧并带计时，8 分钟前用更轻的 `【处理中，已用时X】`。**无工具活动的回合完全维持现状**（v150 零产出保底不动）。沉默时钟从「任一通道最后一次上屏」起算（心跳重绘不是已确认预览，只按确认预览计时会让截止点停在过去、0 延迟空转——敏感性验证抓成 1002 帧）。

## 2q. `2.7.260-12`：上游核查与被踢下线的两处失效

本轮不是从现象出发，而是从**上游核查**出发：企微 2026-08-10 ~ 08-17 重写了整套智能机器人协议文档（doc 62153–62160、62131/62132），并首次发布官方 OpenClaw 插件（`@wecom/wecom-openclaw-plugin`，走 CLI + Skills 路线）与 `@wecom/cli`。

**取文档的方法**（下轮直接复用）：文档站是 SPA，`WebFetch`/`curl` 只拿得到壳。正文接口是 `POST https://developer.work.weixin.qq.com/docFetch/fetchCnt`，**表单编码**、参数 `doc_id`（不是 URL 里的 category id，需先从页面 HTML 内嵌的 `window.settings.categories` 里查映射，该 JSON 还带每篇的 `time` 更新时间戳）；全量目录用 `POST /docFetch/categories`。

### ① 被踢下线 = 一轮 agent 运行 + 一条发往 `unknown` 的推送

企微规定同一机器人同一时刻只能有一条长连接；新连接订阅成功后，服务端向**旧连接**推 `disconnected_event` 再断开它。SDK 1.0.7 已实现该语义（停心跳、清队列、`isManualClose=true` 不重连、`terminate`），但把它与用户事件放在**同一条 `event` 通道**上发出。

本插件的 `client.on("event")` 不区分类型 ⇒ 照走 `handleFrame → dispatchEvent` ⇒ `inboundKind:"event"`、正文 `[event:disconnected_event]`、peer 落成 `direct:unknown`（该帧没有 `from.userid`、没有 `chattype`）；产出后 `reply.ts` 的 `else if (isEvent)` 还会朝 `unknown` 发 markdown。

修复：`handleFrame` 入口精确匹配该事件，记 `ws-kicked` 后直接返回。**不重连**——重连会把连接从新 owner 手里抢回，对方框架再抢回去，无限互踢（官方插件对同一场景的注释与处理相同）。

### ② 「被踢」诊断的关键词早已与 SDK 脱节

`sdk-adapter.ts` 用 `kick` / `owner` / `replaced` 三个关键词判断 disconnect 原因，来自 `2.3.9`（SDK 还没有该事件的年代）。SDK 1.0.7 的真实 reason 是 `New connection established, server disconnected this connection` —— **一个都不含**，`ws-kicked` 因此从不落账。现由事件本身落账；关键词保留（无法证明它对 WS close reason 也是死代码）。

### ③ 主动推送让服务端猜会话类型

doc 62158：`chat_type` 不填时「**优先按群聊处理**」再自动兼容。而入站帧的 `chattype` 早就决定了 `peerKind` 与 `peerId`。现在 `reply.ts` 里朝 `aibot_send_msg` 发的**四处**全部带上：push handle 路径、handle 不可用时的 `sendViaClient` 回落、事件回复的正常分支与错误分支。`outbound.ts` 不动，handle 新参数可选、省略时行为逐字节不变。

SDK 1.0.7 没有这个字段，但 `sendMessage(chatid, body)` 是 `{ chatid, ...body }`、`sendReply` 原样入帧，多带字段即可上线；只在调用点断言，不全局放宽类型。

### ④ 核查中被证伪 / 判定无需改动的

- **MCP 配置拉取会不会占住回执槽拖慢流式**：不会。SDK 的 `replyQueues` 与 `pendingAcks` 均以 `req_id` 为键，`mcp_config` 与流式回复不同队、不同 ack 槽。
- 协议侧逐条核对一致：20480 字节上限（本插件 15360 = 75%）、30 条/分钟与 1000 条/小时、`<think>` 官方折叠、心跳 30 秒、欢迎语走 `replyWelcome` 且 5 秒内、`quote`/`mixed` 入站结构、临时素材分片与体积限额。
- **`wecom_doc` 无需适配**：其覆盖的 wedoc 分组最近更新都在 2024-05-30 或更早；2026 年唯一新增是「管理智能文档内容」16 个 smartpage 接口（属可选扩展）。
- 官方文档写「从首次推送起 **10 分钟**内完成刷新」，本插件按实测 ~6 分钟窗口设计（`BLOCK_PREVIEW_MAX_MS = 300_000`）。**不要按官方数字放大**：现值是被真机 846605/846608 逼出来的。

## 2r. `2.7.260-13`：`851003 no authority` 的真正原因是品类，不是权限

现网现象：同一个 docid、同一个目标文档，`wecom-cli` 读写都成功，改用 `wecom_mcp` 返回 `851003 no authority`；且 MCP 此前一直正常，企微 2026-08 更新文档后才出现。

### 根因

`wecom_mcp` 的 `category` 一路直通到 `aibot_get_mcp_config` 的 `biz_type`，中间**没有归一也没有校验**。而官方取值表（CLI 概述 doc 61944，2026-08-14）里取值与能力名并不同名：`msg` 不是 `message`、`schedule` 不是 `calendar`，且**表格 / 智能表格 / 智能文档三项与文档共用同一个 `doc`**。

模型按能力名猜出来的 `smartsheet` / `smartpage` / `calendar` / `message` 都不在表里。**企微对认不出的 `biz_type` 不报错**，只回一个没有作用域的 URL；这份配置被缓存下来，之后每次调用都是 `851003`。这同时解释了「以前正常」（2026-08 之前取值更宽松）与「CLI 通」（`wecom-cli smartsheet …` 内部走的就是 `doc`）。

### 修复（全部在边界层）

归一别名 → 官方 `biz_type`；**认不出的取值原样放行并告警**（不写死枚举）；缓存键改用 `bizType`（别名与本名共用一份配置与会话）；授权类错误（`850002`/`851003`）作废配置重取一次再试，**只试一次**，仍失败则附可执行提示。

### 举一反三

- **业务错误码此前完全静默**（只原样返回给模型，日志一字没有）——这正是这次只能靠猜的原因。与 `-12` 的 `ws-kicked` 是同一类毛病：**故障发生时没有任何可查痕迹**。现在错误码与 `bizType` 一起落日志。
- **配置 URL 带着授权凭证被完整打进日志**——现在只留 `origin + path`。
- **`tools/list` 返回体没有上限**：`doc` 一个品类 60+ 工具（13+10+28+11），全量 `inputSchema` 一次吃掉大量上下文。超 32KB 退回名称索引并说明用 `method` 前缀取完整 schema；小品类逐字节不变。

### 下次定性的方法

看 `[wecom-mcp]` 日志：`bizType` 不是官方取值 ⇒ 品类问题；`bizType=doc` 且出现 `biz error persists` ⇒ 服务端授权问题，按返回里的 `hint` 排查。

### 未验证的边界

本轮**没有真机复现**——修复依据是官方取值表与代码路径。`tools/list` 的 32KB 阈值也没有现网标定（`doc` 的真实返回体积未实测）。

## 2s. `2.7.260-14`：`wecom_mcp` 严格对齐官方 —— 缺的是请求身份

### 先更正 2r 的两处判断

1. **`-13` 的根因不完整**：把 `851003` 归因到 `biz_type` 品类错误，是在没有官方源码时能做的最好推断，但真正的根因是缺少请求身份 header。
2. **「企微废弃 MCP 平面」是错的**：最新官方插件把 `wecom_mcp` 从**自己的插件**里移除并迁到 `wecom-cli`（包内 `legacy-tool-warning.js` 留了迁移告警），但**企微的 MCP 能力面仍在维护**——官方文档里 MCP（101848）与 CLI（101847）是「AI 能力」（101708）下的**并列两块，均 2026-08-12 更新**。

### 可参考的官方实现在哪

`npm pack @wecom/wecom-openclaw-plugin@2026.7.2` → `package/dist/src/mcp/`（transport 549 行 + tool 224 行 + 6 个拦截器，共 1814 行）。**最新版 `2026.8.17` 里这个目录已被删除**，要读只能取 `2026.7.2`。`wecom_mcp` 本就是官方插件的工具名，本 fork 与它同源——SSE 解析、会话管理、缓存清理、`-32001/-32002/-32003` 处理我们与官方本就一致。

### 根因：`x-openclaw-wecom-userid`

官方在**每一次** MCP HTTP 请求（含 `initialize` 握手）上都带这个 header，透传发起人的企微 userid；我们一次都没发过。MCP 平面是「代替成员」操作的（官方文档：各能力权限需成员单独授权），不带身份服务端不知道以谁执行 ⇒ `no authority`。解释了现网「CLI 通、MCP 851003」与「以前正常」。**该 header 不在任何公开文档里，只存在于官方源码中。**

### 身份必须用原文大小写

新增 `WecomSourceSnapshot.requesterUserId` / `.chatId` 两个**不做小写化**的字段（已有的 `peerId` 是查找键，被 `normalizePeerId` 强制小写）。官方在 `doc-auth-error.js` 留了警告：OpenClaw 构建 sessionKey 时会把 peer id 小写，而企微 `chat_id` 大小写敏感，小写后 `aibot_send_biz_msg` 报 `93006 invalid chatid`。

### 官方的错误码分工（照抄，别自己发明）

- `{850001, 851014}` → **清配置与会话缓存**（机器人授权过期/重置）。我们原来的 `{850002}` 没有依据。
- `{851013, 851014, 851008}` 且 `category === "doc"` → **`aibot_send_biz_msg`（`biz_type=1`）让企微直推授权卡片**，并把原始 `help_message` 拦下不喂给 LLM。
- `851003` → 官方**无特殊处理**。按官方 CLI 技能文档，常见成因是企业可见范围超过 10 人导致智能表格写入受限，解法是走该表「接收外部数据」的 Webhook。

### 刻意保留的两处本地偏离（都不改 wire 行为）

配置 URL 日志脱敏（官方会把带凭证的完整 URL 打进日志）、`tools/list` 超 32KB 退回名称索引（官方无上限）。

### 未移植

官方另外 5 个拦截器：`msg-media`、`smartpage-create` / `smartpage-export`、`smartsheet-upload`（均涉及本地文件系统与沙箱边界），需单独立项。

## 2t. `2.7.260-15`（验证版）：冒烟失败教会的三件事

### 冒烟对照把范围锁死了

```
list  category=doc                      → 成功，19 个工具
call  category=doc method=sheet_get_info→ 851003 no authority
CLI   sheet_info <同一 docid>            → 正常
```

`tools/list` 成功 ⇒ 配置拉取 / URL / 会话 / **品类级授权全正常**；`category` 传的就是 `doc` ⇒ **`-13` 的别名归一根本不是解药，撤回是对的**；同一 docid CLI 通 ⇒ 文档本身有授权。剩下唯一解释：**这份文档的访问权属于成员，而 MCP 调用没带成员身份**（CLI 用 `auth init` 绑定成员的凭据，天然带身份；MCP 走机器人长连接，成员身份要靠请求头透传）。

### ① 身份来源取错了——`-14` 很可能压根没发出 header

官方 `registerTool` 取的是 **`ctx.requesterSenderId`**（OpenClaw core 提供，类型注释「Trusted sender id from inbound context (runtime-provided, not tool args)」，官方变量名 `trustedRequesterUserId`）。我 `-14` 绕道自己的 `source-registry` 去查，而**工具注册时机可能早于入站记录写入**，那条路很可能一直是空的。现在优先取 core 的值，registry 只兜底，并把取值来源打进日志。`chatId`/`chatType` 仍必须用 registry 的原文（core 会小写 peer id，企微 `chat_id` 大小写敏感 ⇒ `93006`）。

### ② 漏抄了官方的诊断行

官方在 `sendRawJsonRpc` 里逐次打印「本次带没带 `x-openclaw-wecom-userid`」。我没抄，于是整整一轮只能靠猜。**照抄官方实现时，诊断代码和功能代码同等重要**。

### ③ 我自加的 `tools/list` 限幅在现网就会误伤

现网 `doc` 品类**只有 19 个工具**就触发了 32KB 降级，返回里没有 `inputSchema` ⇒ 模型只能猜参数名。阈值是我按官方文档「60+ 工具」估算定的，而现网这套 Server 工具更少、schema 更大。**已删除**——一个凭估算定下、在真实规模上就会误伤的保护，不如没有。

### `x-openclaw-wecom-userid` 的证据状态（别再重复核实）

- **官方文档里没有**（MCP / CLI / 长连接全查过）。
- **官方代码里有**：`@wecom/wecom-openclaw-plugin@2026.7.2` 的 `src/mcp/transport.js`，注释「请求 MCP Server 时透传可信企业微信 userid 的 header 名」，每次请求含 `initialize` 都发。写它的是企微团队本人。
- **CLI 不能作旁证**：它用成员自己的凭据，二进制里 `userid` 零出现；其中的 `x-wecom-*` 是文件/输出格式标记（`x-wecom-file-save` / `x-wecom-octet-stream`），不是 MCP 头。
- **没有更新的参考**：`2026.7.2` 是最后一个带 MCP 的官方版本，`2026.8.17-beta.1` 起 `src/mcp/` 整体删除。
- 结论：只能证明「企微自己的客户端在发」，无法从文档证明「服务端确实认」。**风险为零**（HTTP 忽略不认识的头），能否修好是中等把握。

### 现网工具名与官方文档不是同一代

实际：`create_doc` / `sheet_get_info` / `sheet_append_data` / `smartsheet_add_records` / `edit_doc_content`；
文档（2026-08-13）：`doc_create` / `sheet_get` / `sheet_rows_append` / `smartsheet_records_add` / `doc_contents_append`。
命名规则整个反过来。**`biz_type` 取值表可信，但工具层面只能以 `action=list` 的实际返回为准**——据文档判断某个工具「不存在」会得出错误结论。

## 2u. `2.7.260-16`：`851003` 的根因 —— 两条签发路径是两台不同的 Server

### 实测结论（2026-08-26，用现网真实 apikey 逐个探测八个能力）

| 签发路径 | 对端 | `doc` 工具 |
| --- | --- | --- |
| 后台「查看使用方式」`/mcp/v2/bot/<biz_type>?apikey=…` | 「动态\* MCP」**v1.0.5** | **62 个新一代**（`doc_create`/`sheet_get`/`smartsheet_records_*`） |
| `aibot_get_mcp_config` | 旧一代 | **19 个旧一代**（`create_doc`/`sheet_get_info`） |

**决定性证据**：后台地址的返回里服务端自报「机器人身份 + **授权真人用户身份**」，并说明真人授权用户拥有的数据可读可查可下载。⇒ **授权内嵌在 `apikey` 里**，不靠请求头传。`aibot_get_mcp_config` 签发的地址没绑定真人用户 ⇒ 成员的文档一律 `851003`；而 `tools/list` 不需要真人授权 ⇒ 能过。**「list 通、单文档不通」就是这么来的。**

### 各能力实测体积（定阈值的依据，别再凭估算）

`contact` 0.5KB · `msg` 5.8 · `todo` 6.0 · `disk` 6.4 · `schedule` 8.8 · `meeting` 11.4 · `mail` 12.8 · **`doc` 289KB**（62 工具）。
`doc` 仅名称+说明 8.3KB；按前缀：`smartpage_` 8.5 · `doc_` 38 · `sheet_` 50 · `smartsheet_` 191KB。
全部 **stateless**（不返回 `Mcp-Session-Id`）。工具名与官方文档 2026-08-13 逐字一致。

### 结论与做法

- `bot.mcpServers`（`biz_type` → 后台 URL）是**推荐配置**：使用者已验证取消授权再授权 **apikey 不变**。
- **传输层与工具层本就能力无关**，支持全部八个能力不需要任何额外代码。
- `tools/list` 限幅阈值 **48KB 来自实测**（次大 12.8KB vs `doc` 289KB，间隔极宽），超限退名称索引并列出可用前缀。
- `initialize` 后打印对端 `serverInfo` —— 有这行，当初一眼就能看出是两台 Server。

### 两个此前的误判（记下来别再犯）

1. **「缺 `x-openclaw-wecom-userid` 是根因」——错**。现网日志证明它已发出（`useridFrom=ctx.requesterSenderId`），851003 一字未变；这台 Server 的身份来自 apikey。该头仍照官方带上（零风险），但它不是解药。
2. **「`sheet_get_info` 不存在」——错**。那是按官方文档推断的，而现网旧 Server 就叫这个名。**工具层面只能以 `action=list` 的实际返回为准。** 另：MCP 层 docid 是 `e3_…` 形态，与 wedoc REST 的 `dcLdPZ…` 不是一套（`640027` 由此而来，与权限无关）。

### 凭证纪律

真实 apikey **只存在于仓库外的 scratchpad**，代码/测试/文档/日志中一律没有；日志里 URL 只留 `origin + path`。

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
6. 最终回复保持被动 `replyStream` 路径；**思考块前缀永远从同一预算里扣，不得为它加上限**（v147）；预览冻结 5 分钟受微信 ~6 分钟流窗硬限制约束。**上限本身已在 v11 按证据放大**：官方 stream `content` 上限 20480 字节，答案每段 5000 字符、帧 15360 字节（约 75%）；旧的 2000/12000 是 `v2.5.110-112` 在不知道官方数字时的保守猜测。**再往上调需要先做真机验证**（官方给的是 API 上限，不保证客户端不折叠/截断），且**预览帧 3500 与冻结阈值 3000 不要跟着动**——它们直接加重回执槽压力。
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
32. **不要在最终 wire 落定前做字符预算**：Markdown 规范化、literal think 转义、真实 thinking block、completion marker 都可能改变长度；预览、normal final 与 active push 必须继续复用 wire-aware 分段原语。
33. **全帧瞬态状态必须携带它实际保留的正文 source prefix**：preamble/Fast 可清空或缩短当前气泡正文，书签必须同步回退；但仅有瞬态状态时不得设置 `visibleReplyStarted`。
34. **8 分钟绝对门槛管的是「长任务处理中，请勿打断」这句文案与纯状态推送**（v11 界定；cadence 见 38）：不要用最近一次冻结预览时间推迟首状态；长任务状态 ACK 持续不可信时必须切 active push；确认 preview 恢复时必须同时解除后台 timer 和 armed 状态。**两类反馈不共用触发器**：① 流窗已死时，**带新内容**的推送不再等 8 分钟（气泡已经画不动，它是唯一通道）；② 「还活着」由**沉默时长**驱动（见 43），8 分钟前只能用不要求用户改变行为的轻文案。把这两条并回 8 分钟门槛，就会复发「6→8 分钟盲区」和「工具阶段气泡假死」。
35. **不要把 OpenClaw 结构化 lifecycle 事件渲染成任何用户可见文字**（v8 收紧）：命令、参数、路径、搜索词、审批内容与工具结果本就不可外发，工具名也必须降级为通用值——脱敏之后剩下的只有 `🧰 Tool Call: running` 这类零信息量标签，却要占用与正文共享的气泡预算。lifecycle 事件**只能**用作 `runActivityObserved` 的事实证据（`onToolStart`，不产生投递），不得重新接回投递通道。未知/内部 item kind 连证据也不算。
36. **preamble 是「追加式步骤日志」，不是可变状态**（v10 改写；v8 的「当前步骤快照」已被用户现网反馈明确否决——覆盖刷写＝过程没有记录）：一条 commentary item＝一步，按到达顺序追加；**不得改回 latest-wins**（复发「覆盖刷写、过程零残留」），也**不得无界拼接**（v8 教训「答案被挤出预算」由显示端有界尾部＋正文在场时 800 字符限幅承担，不靠丢历史）。步骤边界只能在**源语义层**修复：同 item 原位替换；相邻同文合并且不承接新 id（后续分化＝新步骤）；相邻前缀延续原位延长并承接 id；非相邻真实重复保留。
37. **不要重新引入展示层去重来掩盖过程文字重复**（v8，v10 界定范围）：v6 的跨 item 整段 `Set` 与 v7 的按行 `Set` 都是症状补丁，已删除。插件不得擅自改写模型写下的句子——真出现重复，先查产出侧语义，不要在渲染层删行。36 条的相邻同文/前缀延续合并是**源语义边界修复**（同一句自述被 flush 边界切开），不属于展示层去重；不得扩大到非相邻或模糊匹配。
38. **长任务状态只能有一个时钟**（v9）：三条绘制通道（气泡心跳／冻结刷新／后台推送）必须共用以回合开始时间为锚、吸附到网格的 `nextLongTaskStatusDueAt()`，绘制前查询、绘制后回报，心跳在定时器触发时还要再查一次。让任何通道自持节拍，或让无关事件（过程帧、外部消息、回执缺失）重置这条时钟，就会立刻复发「忽长忽短 + 两条通道各发一次」。
39. **状态名额发出即占用，只有被证明未送达才归还**（v9）：846605/846608 是企微明确拒绝该帧，可以归还并让推送补位；**回执缺失不是未送达的证据**，归还它就会在 5 秒后重复推送同一句状态。名额必须用**确认送达时刻**盖章，不能用帧的合成时刻。
40. **回调 `req_id` 不能再被视为天然唯一**：必须保留 `messageId + ownerToken + TTL` 的动态认领；冲突、重投、缺失、容量或 pending ACK 一律 fail closed，owner 丢失必须永久锁存并在每条投递路径复查。
41. **过程日志的持久化只有一个 durable 前缀书签**（v10，v11 扩写）：所有推送通道一律从 `processLogDurable` 起送增量，**确认送达才推进**（失败推送不推进——提前推进＝步骤从记录里静默消失）；不得引入第二个**投递通道**或区间集合（会造成不连续区间与漏记，这是开发中试过并否决的方案）。v11 新增**唯一一条允许推进 durable 的非推送事件**：企微**拒绝**了某一帧（846605/846608）⇒ 那条气泡再也无人能覆盖（final 也不行）＝已是永久聊天记录，其已确认前缀 `processLogBubble` 折叠进 durable。这份「气泡前缀」只折叠、不投递，且必须**与 durable 保持连续**才可延伸；两个反例必须保留：一帧**不含日志**的正文/思考/冻结帧会整条覆盖气泡 ⇒ 立即作废该前缀；被 wire 合成器**裁掉尾部**的视图 ⇒ 一律不认账。回执不可信（非明确拒绝）**不算**永久，不得折叠。

42. **思考块必须与正文同源做 wire 安全化，并且只显示最新的一段**（v11）：① 它是唯一直达 wire 的模型原文，**必须走 `toWeComMarkdownV2` 并把残留 `<` 中性化**——块尾恒有 `</think>`，任何裸 `<` 都能把它当标签吃掉，连答案一起吞没；截断产生的半截实体与**任何**残留 ``` 必须清理。② **不得改回头部截断**：推理越过上限后每帧逐字节相同，等值判定会静音整条预览通道（现网「输出到一定长度就没消息了」）。③ 代理对在**头尾两端**都不得劈开。④ **正文在场时思考块必须让位**（800 字符/2400 字节）：它和正文共用同一帧预算，不让位就会把答案压到几百字符；渲染块与正文预算必须由**同一次** `resolveThinkingFrameLayout` 产出，不得两处各算一套。

43. **「还活着」由沉默驱动，且必须以工具活动为前提**（v11）：气泡静默满 `PREVIEW_SILENCE_MAX_MS` 才重绘，且沉默时钟从「**任一通道最后一次上屏**」起算——心跳重绘不是已确认预览，只按确认预览计时会让截止点停在过去、定时器 0 延迟空转（实测 1002 帧）。看门狗**只在运行侧报告过工具活动后上岗**：去掉这个前提，每个回合都会进入该通道（实测 21 万帧空转），且无产出回合的绝对门槛保底（禁改 25）会被绕开。工具事件本身**仍然只能作为证据**，不得渲染成任何用户可见文字（禁改 35 不变）。

44. **企微事件帧按白名单放行，不得无差别进入 agent 通道；`disconnected_event` 收到后禁止自动重连**（v12，**v16 修订**）：**放行名单 = `enter_chat` / `template_card_event` / `auth_change_event`，其余一律跳过**——这是官方插件的做法。v12 我写的是「按 eventtype 精确匹配拦截、不要改成白名单式收敛」，当时的本意是别破坏 `enter_chat`/`template_card_event` 的语义；白名单把它们显式列进去，意图保留，而黑名单会漏掉企微自己会推的其它事件（`enter_check_update` 就是一例，它此前会被当成用户消息跑一轮 agent）。另：**`enter_check_update` 必须回复插件版本**（`cmd=ww_ai_robot_enter_event`），**`auth_change_event` 要顺带作废该账号的 MCP 配置缓存**。原文如下——SDK 把断连通知和用户事件放在同一条 `event` 通道上，而该帧**没有 `from.userid`、没有 `chattype`**——照单派发会得到一轮 peer 为 `direct:unknown` 的 OpenClaw 运行，外加一条发往 `unknown` 的推送。必须在 `handleFrame` 入口按 `eventtype` **精确匹配**拦截（不要改成白名单式收敛，`enter_chat` / `template_card_event` 的现有语义不能动）。**重连是禁止的**：连接所有权已属新实例，抢回去只会被再踢，两个实例无限互踢；正确处置是记 `ws-kicked` + session `running:false`，由人停掉重复实例后再拉起。另：**不要为 `feedback_event` 加处理**——本插件从不设置 `feedback.id`，该事件不可能触发。

45. **主动推送必须带 `chat_type`，且只在能确知会话类型的路径上带**（v12）：官方 `aibot_send_msg` 不填该字段时「优先按群聊处理」再兼容，等于每条 DM 推送都先让服务端猜错一次。`reply.ts` 的 `peerKind` 源自入站帧 `chattype`，是权威值，**`reply.ts` 里朝 `aibot_send_msg` 发的每一处都必须带**（v12 有四处：push handle、`sendViaClient` 回落、事件回复的正常与错误分支）——漏掉任意一条就会在该路径上静默退回服务端猜测。本轮是被用例逐层逼出来的：端到端用例抓到第一处遗漏，全量套件抓到第二处。加新的发送路径时必须同步带上。`BotWsPushHandle.sendMarkdown` 的该参数**必须保持可选**：`outbound.ts` 的 Agent 主动发送只有一个 `to`，拿不到可靠会话类型，省略时必须一个字段都不加（`outbound.test.ts` 的 `toHaveBeenCalledWith("lisi", "hello ws")` 精确实参断言即该边界的守卫）。

46. **`wecom_mcp` 的 `category` 必须按官方表归一成 `biz_type`，但不得写死枚举**（v13）：取值与能力名并不同名（`msg`≠`message`、`schedule`≠`calendar`），且**表格 / 智能表格 / 智能文档与文档共用 `doc`**。企微对认不出的 `biz_type` **不报错**，只回一个没有作用域的 URL，缓存之后每次调用都是 `851003 no authority`——排查时极易误判成权限问题。归一必须发生在**入口一次**，缓存键、配置请求、会话、日志全部用同一个 `bizType`，否则别名会各持一份指向同一作用域的配置。认不出的取值**必须原样放行并告警**：官方随时会加新品类，写死枚举会把插件锁在当天那张表上。授权类错误（`850002`/`851003`）作废配置后**只重试一次**——真没授权时再试只是把同一个错误再走一遍。

47. **`wecom_mcp` 的每一次 HTTP 请求都必须带 `x-openclaw-wecom-userid`，且取值必须是原文大小写**（v14，v15 修订）：**取值必须来自 `ctx.requesterSenderId`（OpenClaw core 提供的 trusted sender id），不要绕道插件自己的 registry——工具注册时机可能早于入站记录写入，那条路会是空的（v14 踩过，等于 header 压根没发）**。照抄官方时**诊断代码与功能代码同等重要**：官方每次请求都打印「带没带这个头」，漏抄它会让整轮排查只能靠猜。另：**不要给 `tools/list` 加返回体上限**——现网 19 个工具就会触发按文档估算定下的 32KB 阈值，模型因此拿不到 `inputSchema`（v13 加、v15 删）。MCP 平面是「代替成员」操作的，不带身份 ⇒ 服务端回 `no authority`（现网 `851003` 的真正根因）。`initialize` 握手也要带。身份只能取 `WecomSourceSnapshot.requesterUserId` / `.chatId` 这两个**原文**字段——`peerId` 是被强制小写的查找键，用它会让 `aibot_send_biz_msg` 报 `93006 invalid chatid`（官方源码在同一处踩过）。业务错误码的分工照抄官方，**不要自己发明**：`{850001, 851014}` 清缓存、`{851013, 851014, 851008}` + `category==="doc"` 推授权卡片并拦下 `help_message`、`851003` 不做特殊处理。`category` **原样透传**，不做别名归一（官方如此）。

48. **`wecom_mcp` 的接入地址优先用后台签发的 `bot.mcpServers`，不要只信 `aibot_get_mcp_config`**（v16）：两者指向**两台不同的 MCP Server**——后台地址是「动态\* MCP」v1.0.5（`doc` 62 个新一代工具），其 apikey **内嵌了授权真人用户**；`aibot_get_mcp_config` 签发的是旧一代、19 个工具且**未绑定真人用户**，对成员拥有的文档一律 `851003`，而不需要真人授权的 `tools/list` 却能过。排查时**先看 `initialize` 打出的 `serverInfo`**，一眼就能分辨对端是哪台。工具名**只能以 `action=list` 的实际返回为准**，不能拿官方文档当准（现网旧 Server 就叫 `sheet_get_info`）。`tools/list` 的限幅阈值**必须基于实测体积**——按文档估算定过一次 32KB，在 19 个工具上就误伤了。

49. **`wecom-cli` 的凭据协议不得在插件内复刻**（v18）：签名、AES-GCM、`credentials.enc`、`.encryption_key` 和原子写全部委托给插件私有 `@wecom/cli`；插件只负责按 `(botId, secret)` 选目录、短路、并发策略和冷却。

50. **`auth init` 必须由插件非交互短路管理**（v18）：只在目录缺少两个凭据文件或命中允许的重签路径时 spawn `auth init --bot-id --secret`；不得把 secret 写入普通命令日志，也不得引导用户手动执行默认目录的 `auth init`。

51. **CLI 环境只能由插件注入**（v18）：模型参数拒绝 `WECOM_CLI_*=`、`--config-dir` 和 `--home`；运行时固定 `WECOM_CLI_CONFIG_DIR` 与 state cwd，配置透传仅限三个官方联调变量。

52. **绝不使用 PATH 上的全局 `wecom-cli`**（v18）：二进制只从插件依赖的平台包或明确的 `channels.wecom.cli.binPath` 寻址；多账号缺少 `agentAccountId` 时宁可失败，不回退默认企业。

53. **MCP 兜底必须证明业务尚未执行**（v18）：只兜配置层失败、`is_authed=false` 和明确 `851003`；`851013/851014/851008`、`45009`、超时、5xx、连接重置不自动重跑。兜底结果与日志必须带 `via=cli-fallback:<reason>`，否则不能宣称已诊断。

> v18 对第 47 条的「`851003` 不做特殊处理」作了**有界例外**：原 MCP 结果仍保留，只有明确业务拒绝且 CLI 登录态已在启动预热完成时才转 CLI；这不是恢复无条件重试。

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
- **真机（企微网关/客户端）验证仍未做**，`2.7.260-12` 发布后按优先级确认：
  0. **`chat_type`（v12 唯一改变上线帧形态的改动）**：各发一条**单聊**推送与**群聊**推送，确认送达且不串会话。异常就直接 revert 该 commit，不牵连另外两项。
  0b. **被踢下线**：用同一 BotID 起第二个实例，确认旧实例**不再产生一轮 agent 运行**、日志里出现 `[wecom-ws] handed-over` 与 `ws-kicked`、且**不自动重连**。
  1. **放大后的显示（本轮唯一没有证据覆盖的改动）**：发两条带尾部哨兵的长答案——3500 字（10500B）与 6000 字（18000B），确认客户端**完整显示到尾部**、不折叠不截断。若 18000B 被截，把 `WECOM_STREAM_FINAL_MAX_CHARS` 退回到验证通过的档位。
  2. **思考块**：长推理时气泡**持续刷新**（不再停在某个长度）、能看到**最新**的思考、`</think>` 之后的答案始终可见；推理里含 `<`、代码围栏、表格时答案不消失。
  3. **长任务**：流窗死亡（约 6 分钟）后**立刻**开始收到带新步骤的推送，首条**不重复**气泡里已显示过的步骤；收尾**没有**「📋 本轮过程记录」；无新步骤的分钟不再收到状态推送。
  4. **工具阶段**：思考结束后跑长工具时，气泡约每 90 秒重绘一次并带 `【处理中，已用时X】`，满 8 分钟后文案切回「长任务处理中，请勿打断」。
  5. 继续观察：相邻气泡、复用 `req_id`、迟到 ACK、emoji 边界、群聊接管。
- **上游 `YanHaidao/wecom` 已有新提交未合并**（markdown 子集拆分、多分片发送节流、agent-api 骨架重构、零引用清理等）：本轮任务范围不含上游同步，合并时按第 2f 节对照表处理 `package.json`，并注意上游的多分片节流可能与本仓库的分段/书签逻辑相互影响。
- `npm audit --omit=dev`：`2.7.260-12` 已把 `undici` 升到 **7.29.0**，当前输出 **found 0 vulnerabilities**。`fast-xml-parser` 停在 5.10.1（latest 5.11.0，无告警、无需求，刻意不动）。
- 发布 tarball 不入 git（*.tgz 未跟踪），以 changelog 打包记录的 shasum 为准。**打包必须在文档写完、tag 打好之后再做**：`package.json`（版本号）与 `README.md` 都在包内，先打包会得到一个与发布态不符的指纹（`2.7.260-11` 踩过一次）。打包记录本身写在 tag **之后**的提交里——把哈希写回包内文件会自我指涉。`npm pack` 对同一棵树是确定性的，可用「从 tag 重打得到同一 SHA-256」来复核。
  - **更正（v12 实测）**：`package.json` 的 `files` 只包含 `dist` / `index.ts` / `openclaw.plugin.json` / `README.md` / `LICENSE`（v11 的 139 个文件 = 5 + 134 个 dist）。`SESSION_HANDOFF.md` 与 `changelog/` **不在包内**，v11 的说明写错了。时序结论不变（`README.md` 与版本号仍在包内），但改这两份文档不会影响指纹。

## 7. 版本脉络备忘

`v118`（稳定基线）→ v119-135 开发线**未入主线** → `v136` 基于 v118 重建 → `v137` init-conflict 短重试 → `v138` 媒体+文字合并 → `v139` OpenClaw 7.1 适配 + 投递抗丢失 → `v140` 未发布体验包 → `v141` routed-final 收口 + SDK 1.0.7 → `v142` 进度/模型流解耦 → `v143` 暖会话 metadata 解阻塞 → `v144` 外部答案成功后的旧流静默结算 → `v145` retry/keepalive/注册表/source 生命周期闭环 → `v146` 入站即时确认、被接管消息并入、提示与事实对齐、7.1 冻结中止有界等待 → `v147` 回执缺失不再熄灭进度通道、错误 final 保留思考块、被接管失败文案不外泄、接管与中止同 tick 发布 → `v148` 失败长任务的推送带上耗时与框架、新增长任务诊断 → `v149` 文件/文字双向并入与后台产出书签 → **`2.7.260-1`（原 v150）** 时间驱动长任务反馈与 final 重试保全 → **`2.7.260-2`** 完成态接收 TOCTOU 与重复错误记录修复 → **`2.7.260-3`（已撤回）** preamble 候选 → **`2.7.260-4`** preamble 快照、8 分钟/15 秒节奏、最终 wire 预算与可见正文书签统一 → **`2.7.260-5`** 结构化真实进度、动态 `req_id` owner、文件+文字相邻气泡与迟到 ACK 根治 → **`2.7.260-6`** 跨 commentary item 的完全同文 preamble 精确去重 → **`2.7.260-7`** 最终瞬态气泡按可见行统一去重 → **`2.7.260-8`** 删除结构化工具进度通道、preamble 回到当前步骤快照、移除 v6/v7 两层展示层去重 → **`2.7.260-9`** 长任务状态改为 60 秒并统一到唯一的绝对网格时钟 → **`2.7.260-10`** 过程文字改为追加式步骤日志：气泡编号追加显示、推送按 durable 书签送增量、final 后「📋 本轮过程记录」落档（v8 的当前步骤语义被现网反馈否决）→ **`2.7.260-11`** 思考块与正文同源做 wire 安全化并改显示最新一段（根治「只有思考块没有答案」与「输出到一定长度就卡死」）、正文在场时思考块让位、流窗一死推送立刻接手且不重复永久气泡里的步骤、取消「📋 本轮过程记录」、消息上限按官方 20480 字节调到约 75%、新增工具阶段沉默看门狗 → **`2.7.260-12`** 上游核查：SDK 无新版本可升；断连事件不再被当成用户消息跑一轮 agent 且「被踢」诊断改由事件落账（刻意不重连）、`undici` 升 7.29.0 清掉 1 个 high、主动推送在四处发送路径上显式带 `chat_type` → **`2.7.260-13`** `wecom_mcp` 的 `category` 按官方表归一成 `biz_type`（`851003` 的真正原因是品类不是权限），授权类错误可诊断可自愈可行动，并补上业务错误码日志、配置 URL 脱敏与 `tools/list` 限幅；该模块从零测试覆盖补到 28 条 → **`2.7.260-14`** `wecom_mcp` 严格对齐官方实现：补上每次请求都缺的 `x-openclaw-wecom-userid` 身份 header（`851003` 的真正根因）、身份取原文大小写、官方 User-Agent + undici fetch、官方错误码分工、文档授权引导卡片；撤回 `-13` 自造的别名归一与 851003 重试 → **`2.7.260-15`（验证版，未发布）** 冒烟失败后收口：身份改取 core 的 `ctx.requesterSenderId`（`-14` 绕道 registry 很可能一直是空的）、补上官方那行「带没带身份」的诊断、删掉自加的 `tools/list` 限幅（现网 19 个工具就误伤）→ **`2.7.260-16`（验证版）** 用真实端点坐实 `851003` 根因是**两台不同的 MCP Server**（后台 apikey 内嵌授权真人用户，`aibot_get_mcp_config` 的没有）；`bot.mcpServers` 升格为推荐配置、八个能力全可用；`tools/list` 限幅按实测体积以 48KB 回归；打印对端 serverInfo。

**版本号规则**：`<上游基线>-<构建号>`。构建号在**同一基线内**单调递增；**上游基线一变就从 1 重新计数**——`2.5.110` 基线走到 `2.5.110-149`，合并上游 `2.7.260` 后重新从 `2.7.260-1` 开始。tag 为 `released/<完整版本号>`，简报为 `changelog/v<完整版本号>.md`。
