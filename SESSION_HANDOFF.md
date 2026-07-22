# SESSION HANDOFF — OpenClaw WeCom 插件维护交接

> 最后更新：2026-07-22（v2.5.110-143 发布）。新会话开工前先读本文件、`README.md`、`changelog/README.md` 与最新版本简报。

## 1. 当前状态

- 维护版本：`2.5.110-143`，发布标签 `released/2.5.110-143`，包 `yanhaidao-wecom-2.5.110-143.tgz`（204,467 bytes；npm shasum `ea5c1e5ffdc45a4e930caefd60e216b00eb631ce`；SHA-256 `63a4bdcb3a5db6f816c7a710a585a81e26b78fa0896a2e03afc3d70d6a1fbd2f`）。
- 生产环境：OpenClaw **2026.7.1**；仓库 devDependency 与 peer 基线仍为 **2026.6.11**（`node_modules/openclaw`），代码需双版本兼容。
- 企业微信 Bot SDK：`@wecom/aibot-node-sdk` **1.0.7**（固定版本）。
- 远端纪律：**只推 `fork`（git@github.com:liny90626/wecom.git），绝不推 `origin`（上游 YanHaidao）**；提交邮箱已固化为 `liny90626@users.noreply.github.com`（GH007 教训）。
- 发版纪律：打包、打 tag、推远端、更新发布文档均需用户明确批准。
- 测试基线：42 文件 / 413 测试全绿；核心四文件套件无缓存串行复跑 170 测试全绿；`npm run build`、`npx tsc --noEmit`、`npm run verify-dist`、`node scripts/patch-wecom-b3-merge-thinking.mjs --check`（B1/B2/B3 链）、`git diff --check` 全部通过；生产依赖审计为 0 漏洞。
- `reply.test.ts` 头部有 `vi.setConfig({ testTimeout: 30_000 })`：该套件 fake-timer 密集，全量并发冷缓存下墙钟可超默认 5s（历史上多次假超时、失败集合随机）。不要改回全局 timeout，也不要因单次全量超时怀疑回归——先单文件复跑。

## 2. v143 事件档案（为什么改成现在这样）

本版在 v142 进度投递修复上继续处理三类会话/错误收口问题：

1. **暖会话被 best-effort metadata 写队列阻塞**：插件此前等待 OpenClaw `recordInboundSession` 跟踪的所有 metadata task；该队列按 agent 串行，任一旧写入卡住都能让正常暖会话在模型派发前等待到 60 秒 prepare timeout。v118 不等待这类 task，因此没有该退化。
2. **真实 OpenClaw 错误 final 被包装成成功续文**：流窗口过期后，`LLM request failed.`、`LLM request timed out.` 等 `isError` final 仍复用了成功 fallback，可能显示“继续输出”并追加“（回复完毕）”，让未完成任务看起来已经完成。
3. **prepare timeout 泄露内部英文**：准备阶段失败会直接展示 `WeCom WS reply failed: ...`，既不友好，也无法告诉用户消息其实尚未进入模型处理。

修复（详见 `changelog/v2.5.110-143.md`）：暖会话只登记 metadata 并立即派发，冷会话保留最多 1 秒初始化顺序窗口；所有后台 task 仍立即挂接 `allSettled`，避免未处理拒绝。错误 final 按失败语义生成 fallback，不再追加完成标记；prepare timeout 使用明确中文提示。没有新增模型/工具重试、轮询、强制清理或额外网络等待。生产依赖同步升级到 `fast-xml-parser 5.10.1` 与 SDK 允许范围内的 `axios 1.18.1`，审计清零。

## 3. OpenClaw 7.1 核心机制速查（源码级已验证）

- **会话准入错误（run 前抛出，可安全重试一次）**，插件按文案匹配（`src/shared/reply-errors.ts`，有逐字单测）：
  - `reply session initialization conflicted for <sessionKey>`（6.11/7.1 皆有）
  - `Session "<sessionKey>" changed|was deleted while starting work. Retry.`（7.1 新增）
  - `timed out draining work before reply session rollover: <sessionKey>`（7.1 新增；15s interrupt 等待失败即自持，直到占用 admission 释放或网关重启）
- **abort 冻结**：模型回合一结束（`freezeAbort` 在 turn 的 finally），整个投递/收尾阶段 abort 都被拒绝——`abortAndDrainAgentHarnessRun` 返回 `aborted:false` 是健康 dispatch 的**正常表现**，不是卡死证据。
- **forceClear 危险**：无属主校验，会把健康 run 打成 `run_failed`（用户会收到核心英文“Something went wrong…”），还可能误清刚复用同 sessionId 的新 run，且不取消后端（僵尸继续持有 session 写锁）。**插件已彻底不用。**
- **问题2 两种机制的日志判别**：
  - 排队 followup：消息到达时有 `queue message failed: reason=not_streaming|...`（debug）；dispatch 快速返回；释放后出现**全新 runId** 的 agent run，答案走 routeReply 主动推送。
  - 停车 admission：dispatch 一直不返回；诊断开启（7.1 默认开）时每 ~6 分钟出 `session.stalled`/`visible_reply_wait_timeout`，可能以 `reply-operation-active` 静默丢弃收场；释放后是**同一 dispatch** 继续流式输出。

## 4. 生产观察关键词

`[wecom-b3] inbound-session-metadata-deferred`（冷会话 metadata 超过 1 秒，已继续派发）· `dispatch-absorbed-by-active-run`（消息被并入，用户收到提示）· `dispatch-deferred-no-visible-reply`（回合转后台）· `progress-delivery-failed`（单次进度投递失败，模型流不受阻）· `progress-drain-timeout`（500ms 封口超时，随后应走 final 兜底）· `pre-dispatch-run-drain(-result|-failed)` · `dispatch-init-conflict-handoff-retry` · `final-retry-failed ambiguous=true|false` · `final-retry-exhausted`（随后应有一次 fail-notice）· `final-retry-skip-superseded` · `[wecom-preview] expired-notice-deferred`（9 分钟挂起）· `expired-notice-failed`（任务未结算时下一分钟再试）。
若 `dispatch-absorbed-by-active-run` 后长期无答复：占用 run 是僵尸——等 7.1 诊断自愈或再发一条消息触发接管排空。

## 5. 禁改事项（每条都对应真实事故）

1. **不要恢复 forceClear / 分钟级等待 / 重试阶梯 / per-peer 熔断器 / synthetic thinking**（v132-v135 灾难线，v136 重建时明确移除）。
2. **不要把 ambiguous 推送失败改回“不重试”**——会复发 v139 问题1（答案永久静默丢失）。重试必须复用**失败现场的同一 retryRequest 身份**（text/marker/limits），否则分片进度被重置 → 整条重发（终审确认过的缺陷）。
3. **不要给纯思考预览置 `visibleReplyStarted`**——判定依据是 `bodySourceText` 字段**存在性**（可为空串），不是真值；改回真值判定会让带代码块正文被误判不可见（B3 倒退，验证 agent 实证过）。
4. **不要在 flag-empty 分诊前删掉 abort 守卫**、不要让被接管 handle 产生任何合成 final（“（回复完毕）”乱入新会话）。
5. **`runFinalPushRetry` 的接管抑制要在执行点重算**（`supersededByNewInbound && visibleReplyStarted && delivered>0`），别只信 supersede 时冻结的 `suppressSupersededFinalPush`。
6. 最终回复保持被动 `replyStream` 路径；不动 12000 字节上限；预览冻结 5 分钟（`BLOCK_PREVIEW_MAX_MS`）受微信 ~6 分钟流窗硬限制约束，**不能**照搬“延到 9 分钟”——9 分钟只作用于 `PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS`（后台处理提示）。
7. **不要在 OpenClaw reasoning/Fast 回调中重新直接等待企微网络请求**，否则会恢复 v142 已根治的反向背压；进度必须经单一尾队列登记，final 必须先 seal 再进入 ReplyHandle。

## 6. 已知边界与待办观察

- Fast auto-off 后若 OpenClaw 明确 deferred/yield 且本回合已有活动，会正常收口等待后台结果；真正没有正文、没有外部投递且没有 deferred 证据的 auto-off 回合仍保留中断保护。Fast auto-on 继续允许合法无正文结束。
- 暖会话不再等待 metadata；冷会话只等待 1 秒。看到 `inbound-session-metadata-deferred` 表示写入仍在后台结算且派发已继续，不应再把它当作消息失败。
- OpenClaw 自身生成的错误 final 仍会保留原错误正文供诊断，但会明确标为“任务未完成”，且绝不追加“（回复完毕）”。
- 500ms 是进度封口的有界等待，不会强杀已经进入 SDK 的 ACK；若 ACK 继续阻塞，final 仍需经过 ReplyHandle 既有 5.5s 等待后转主动推送。因此极慢网络下完整 final 可能稍迟，但不会再反向卡住 OpenClaw 模型事件流。
- 6.11 上“真空回合 + 有思考活动”现以静默/“（回复完毕）”收口而非报错（生产为 7.1，核心有 #100456 可见兜底，无影响）。
- ambiguous 补发存在有界重复风险（仅未确认分片、≤3 次）——刻意取舍，静默丢失代价更高。
- 被接管且“已可见”的旧 final 仍按 B3 丢弃，且核心的 pendingFinalDelivery 恢复副本会因“投递成功”被清除——这是 B3 设计语义，不是 bug。
- 观察 `final-retry-failed ambiguous=true` 频率：若高发，说明推送链路（WS 重连/ACK）不稳，优先查网络而非改重试参数。
- `monitor.integration.test.ts`、`sandbox-media.test.ts` 历史上环境耦合敏感（当前全绿）；全量失败先怀疑负载/环境，再怀疑回归。
- 发布 tarball 不入 git（*.tgz 未跟踪），以 changelog 打包记录的 shasum 为准。

## 7. 版本脉络备忘

`v118`（稳定基线）→ v119-135 开发线**未入主线** → `v136` 基于 v118 重建 → `v137` init-conflict 短重试 → `v138` 媒体+文字合并、接管排空 → `v139` OpenClaw 7.1 适配 + 投递抗丢失 → `v140` 未发布体验包 → `v141` routed-final 收口 + 持续长任务状态 + SDK 1.0.7 → `v142` 进度/模型流解耦 + final 有界封口 + 长任务时钟修正 → `v143` 暖会话 metadata 解阻塞 + 错误 final 正确收口 + 依赖安全补丁（当前）。
