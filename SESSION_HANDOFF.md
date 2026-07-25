# SESSION HANDOFF — OpenClaw WeCom 插件维护交接

> 最后更新：2026-07-25（v2.5.110-146 未发布候选）。新会话开工前先读本文件、`README.md`、`changelog/README.md` 与最新版本简报。

## 1. 当前状态

- 当前开发候选：分支 `fix/v146-inbound-delivery-stability`，生产代码基线提交 `5cfd4a4`；完成本文档提交后相对 `main` 有 7 个本地提交，文档提交以当前 `HEAD` 为准。
- 当前正式版本仍是 `2.5.110-145`，发布标签 `released/2.5.110-145`，包 `yanhaidao-wecom-2.5.110-145.tgz`（204,358 bytes；npm shasum `b7bdbd5ed7a4d1143989c794f4be8ca980343afe`；SHA-256 `524c968990200084b7ff6ca7234e914ebcc4364dcf36f33323ffecd472f53cf2`）。
- v146 候选尚未升 `package.json` 版本、尚未打包、没有 `released/2.5.110-146` 标签，也未推送远端；不要把候选简报误读为正式发布记录。
- 标签状态：`released/2.5.110-144` 已于 2026-07-24 从本地与 `fork` 删除；v144 变更记录仅作历史归档，其修复已由 v145 继承，不要重新发布 v144。
- 生产环境：OpenClaw **2026.7.1**；仓库 devDependency 与 peer 基线仍为 **2026.6.11**（`node_modules/openclaw`），代码需双版本兼容。
- 企业微信 Bot SDK：`@wecom/aibot-node-sdk` **1.0.7**（固定版本）。
- 远端纪律：**只推 `fork`（git@github.com:liny90626/wecom.git），绝不推 `origin`（上游 YanHaidao）**；提交邮箱已固化为 `liny90626@users.noreply.github.com`（GH007 教训）。
- 本轮授权边界：仅更新交接/相关文档并创建本地提交；**不得打 tag、不得推远端，也未获准打包**。
- 候选测试基线：43 文件 / 467 测试全绿；重点生命周期 5 文件 / 249 测试全绿；`npm run build`、`npx tsc --noEmit`、`npm run verify-dist`、B1/B2/B3 链与 `git diff --check` 全部通过。生产依赖未变。
- `reply.test.ts` 头部有 `vi.setConfig({ testTimeout: 30_000 })`：该套件 fake-timer 密集，全量并发冷缓存下墙钟可超默认 5s（历史上多次假超时、失败集合随机）。不要改回全局 timeout，也不要因单次全量超时怀疑回归——先单文件复跑。

## 2. v146 候选事件档案（为什么改成现在这样）

本轮以 `released/2.5.110-118` 的简单、低等待路径为稳定性参照，由 Sol xhigh 与 Terra xhigh 两路独立审查当前入站与回复链路，随后在主线程复现并修复：

1. **媒体+文字合并不完整**：普通文字曾承担不必要等待；媒体合并后未登记原媒体 `messageId`，重投可能二次执行；群聊键缺少 `senderId`，存在跨成员误合并风险。
2. **pending 提前接管 active**：新消息还在 prepare、尚未确认 OpenClaw 可以接纳时就 supersede 旧 handle。若旧 run 处于不可中断的 final/ACK 阶段，新消息随后被 busy 拒绝，会同时损害旧 final 和新指令。
3. **WS runtime owner 生命周期断裂**：旧 adapter 停止后，prepare/preview/placeholder/final retry 和真实 core Promise 没有统一退出边界；迟到回复可能借用同账号 replacement WS。
4. **busy 重试把 fallbackEligible 也包含进来**：fallbackEligible 可能表示已执行或 deferred，二次 dispatch 会重复模型、工具或队列副作用。
5. **第二轮 busy 提示绕过失败兜底**：dispatcher 直接 `deliver()`，提示自身失败时没有进入 ReplyHandle `fail()`。

修复（详见 `changelog/v2.5.110-146.md`）：普通文字立即派发，仅媒体在前时等待 1 秒；合并事件通过 alias 同时去重媒体与文字，群聊按发送者隔离；pending 与 active 注册分层；ReplyHandle 绑定创建它的 runtime owner；所有 drain 单代最多 5 秒；只有 flagless zero-output、无活动、无 fallback/deferred 且仍有 active run 的明确未接收结果允许一次 500ms 重试。没有 forceClear、分钟级等待、重试阶梯或普通文字固定延迟。

## 3. OpenClaw 7.1 核心机制速查（源码级已验证）

- **会话准入错误（run 前抛出，可安全重试一次）**，插件按文案匹配（`src/shared/reply-errors.ts`，有逐字单测）：
  - `reply session initialization conflicted for <sessionKey>`（6.11/7.1 皆有）
  - `Session "<sessionKey>" changed|was deleted while starting work. Retry.`（7.1 新增）
  - `timed out draining work before reply session rollover: <sessionKey>`（7.1 新增；15s interrupt 等待失败即自持，直到占用 admission 释放或网关重启）
- **abort 冻结**：模型回合一结束（`freezeAbort` 在 turn 的 finally），整个投递/收尾阶段 abort 都被拒绝——`abortAndDrainAgentHarnessRun` 返回 `aborted:false` 是健康 dispatch 的**正常表现**，不是卡死证据。
- **forceClear 危险**：无属主校验，会把健康 run 打成 `run_failed`（用户会收到核心英文“Something went wrong…”），还可能误清刚复用同 sessionId 的新 run，且不取消后端（僵尸继续持有 session 写锁）。**插件已彻底不用。**
- **busy 结果必须按是否可能已执行分诊**：
  - `noVisibleReplyFallbackEligible=true` 可能是已执行或 deferred continuation，插件只能收口或提示，绝不能再次 dispatch。
  - flagless zero-output 且没有 reasoning/tool/progress、没有 source suppression，返回后仍能查到 active run，才视为“明确未接收”；插件最多排空并重试一次。
  - pre-dispatch 检测到旧 run 且 `abortAndDrainAgentHarnessRun` 返回 `aborted:false, drained:false` 时，新指令直接友好拒绝，旧 active handle 不得被 supersede。
- **abort 冻结后的 owner 退出**：OpenClaw 可能不接受 abort，但 adapter stop/reload 仍须使旧 ReplyHandle 本地失效、停止 timer，并等待真实 core Promise 结算后释放 owner；不能把“本地 caller 已返回”当作 core 已结束。

## 4. 生产观察关键词

`[wecom-b3] inbound-session-metadata-deferred`（冷会话 metadata 超过 1 秒，已继续派发）· `dispatch-pending-register`（只进入 prepare 层，尚未接管 active）· `pre-dispatch-run-drain(-result|-failed)` · `pre-dispatch-run-busy`（旧任务未释放，新指令未执行）· `dispatch-handoff-retry reason=init-conflict|busy-result`（仅一次）· `dispatch-busy-not-accepted`（最终友好提示）· `dispatch-deferred-no-visible-reply`（回合转后台，不重试）· `progress-delivery-failed` · `progress-drain-timeout` · `*-wait-timeout`（单代 5 秒有界等待）· `final-retry-failed ambiguous=true|false` · `final-retry-exhausted` · `final-retry-skip-superseded` · `[wecom-ws] merged media+text` · `duplicate pending media ignored`。

若看到 `pre-dispatch-run-busy`，新指令没有交给 OpenClaw，旧任务应继续输出；若旧任务结束后长期仍持续 busy，优先检查 OpenClaw active run/诊断日志，不要在插件侧 forceClear。

## 5. 禁改事项（每条都对应真实事故）

1. **不要恢复 forceClear / 分钟级等待 / 重试阶梯 / per-peer 熔断器 / synthetic thinking**（v132-v135 灾难线，v136 重建时明确移除）。
2. **不要把 ambiguous 推送失败改回“不重试”**——会复发 v139 问题1（答案永久静默丢失）。重试必须复用**失败现场的同一 retryRequest 身份**（text/marker/limits），否则分片进度被重置 → 整条重发（终审确认过的缺陷）。
3. **不要给纯思考预览置 `visibleReplyStarted`**——判定依据是 `bodySourceText` 字段**存在性**（可为空串），不是真值；改回真值判定会让带代码块正文被误判不可见（B3 倒退，验证 agent 实证过）。
4. **不要在 flag-empty 分诊前删掉 abort 守卫**、不要让被接管 handle 产生任何合成 final（“（回复完毕）”乱入新会话）。
5. **`runFinalPushRetry` 的接管抑制要在执行点重算**（`supersededByNewInbound && visibleReplyStarted && delivered>0`），别只信 supersede 时冻结的 `suppressSupersededFinalPush`。
6. 最终回复保持被动 `replyStream` 路径；不动 12000 字节上限；预览冻结 5 分钟（`BLOCK_PREVIEW_MAX_MS`）受微信 ~6 分钟流窗硬限制约束，**不能**照搬“延到 9 分钟”——9 分钟只作用于 `PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS`（后台处理提示）。
7. **不要在 OpenClaw reasoning/Fast 回调中重新直接等待企微网络请求**，否则会恢复 v142 已根治的反向背压；进度必须经单一尾队列登记，final 必须先 seal 再进入 ReplyHandle。
8. **所有跨请求全局状态都必须带完整作用域或属主身份**：至少包含账号、direct/group 和 peer；注销必须校验原注册对象，终态必须同步取消已排队的旧异步任务。
9. **不要重新合并 pending 与 active 注册时序**：新消息必须先证明旧 run 可释放，才能 supersede active handle；busy 拒绝路径必须保留旧 final。
10. **不要把 `retryFlaglessBusy` 扩大到 fallbackEligible/deferred**：第一轮只允许明确未接收结果抛内部重试信号，第二轮必须关闭该信号并由 orchestrator 统一执行 `deliver -> fail`。
11. **不要提前释放 runtime owner，也不要允许旧 reply 使用 replacement push handle**：owner 至少覆盖真实 core Promise 和 final retry；stop/reload 必须先 retire owner 再断开 client。
12. **不要删除媒体 `dedupeAliases` 或群聊 merge key 中的 `senderId`**：前者防企微重投后二次执行，后者防不同群成员的文件和文字串联。

## 6. 已知边界与待办观察

- 普通文字没有固定合并等待；只有媒体在前时保留 1 秒窗口。文字晚于窗口到达会作为独立消息处理，这是避免所有消息额外延迟的明确取舍。
- 新指令遇到不可释放旧 run 时会提示“确认新指令未执行后再重试”；该提示代表拒绝，不代表已排队或已并入旧任务。
- 单个 handoff/drain 最长等待 5 秒；它只在存在 pending/active 冲突时触发，不应出现在无旧任务的普通文字快路径。
- 本地依赖只能直接运行 OpenClaw 6.11；7.1 的新 admission/flagless busy 已通过模拟回归覆盖，但 v146 发布前仍需在真实 7.1 网关体验长任务、文件+文字和回复途中插入新消息。
- Fast auto-off 后若 OpenClaw 明确 deferred/yield 且本回合已有活动，会正常收口等待后台结果；真正没有正文、没有外部投递且没有 deferred 证据的 auto-off 回合仍保留中断保护。Fast auto-on 继续允许合法无正文结束。
- 暖会话不再等待 metadata；冷会话只等待 1 秒。看到 `inbound-session-metadata-deferred` 表示写入仍在后台结算且派发已继续，不应再把它当作消息失败。
- OpenClaw 自身生成的错误 final 仍会保留原错误正文供诊断，但会明确标为“任务未完成”，且绝不追加“（回复完毕）”。
- 500ms 是进度封口的有界等待，不会强杀已经进入 SDK 的 ACK；若 ACK 继续阻塞，final 仍需经过 ReplyHandle 既有 5.5s 等待后转主动推送。因此极慢网络下完整 final 可能稍迟，但不会再反向卡住 OpenClaw 模型事件流。
- 6.11 上“真空回合 + 有思考活动”现以静默/“（回复完毕）”收口而非报错（生产为 7.1，核心有 #100456 可见兜底，无影响）。
- ambiguous 补发存在有界重复风险（仅未确认分片、≤3 次）——刻意取舍，静默丢失代价更高。
- 被接管且“已可见”的旧 final 仍按 B3 丢弃，且核心的 pendingFinalDelivery 恢复副本会因“投递成功”被清除——这是 B3 设计语义，不是 bug。
- `observedReplyDelivery` 是 OpenClaw 对已提交 source reply 的证明，不是“开始尝试”；不要把 v144/v145 早结算扩大到普通 outbound side effect 或未观察到投递的 message-tool 回合。
- 观察 `final-retry-failed ambiguous=true` 频率：若高发，说明推送链路（WS 重连/ACK）不稳，优先查网络而非改重试参数。
- `monitor.integration.test.ts`、`sandbox-media.test.ts` 历史上环境耦合敏感（当前全绿）；全量失败先怀疑负载/环境，再怀疑回归。
- 发布 tarball 不入 git（*.tgz 未跟踪），以 changelog 打包记录的 shasum 为准。

## 7. 版本脉络备忘

`v118`（稳定基线）→ v119-135 开发线**未入主线** → `v136` 基于 v118 重建 → `v137` init-conflict 短重试 → `v138` 媒体+文字合并、接管排空 → `v139` OpenClaw 7.1 适配 + 投递抗丢失 → `v140` 未发布体验包 → `v141` routed-final 收口 + 持续长任务状态 + SDK 1.0.7 → `v142` 进度/模型流解耦 + final 有界封口 + 长任务时钟修正 → `v143` 暖会话 metadata 解阻塞 + 错误 final 正确收口 + 依赖安全补丁 → `v144` 外部答案成功后的旧流静默结算 → `v145` retry/keepalive/注册表/source 生命周期与作用域闭环（当前正式版）→ `v146` 入站合并、接管顺序、runtime owner 与 busy 重试收敛（当前未发布候选）。
