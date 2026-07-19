# SESSION HANDOFF — OpenClaw WeCom 插件维护交接

> 最后更新：2026-07-19（v2.5.110-142 发布）。新会话开工前先读本文件、`README.md`、`changelog/README.md` 与最新版本简报。

## 1. 当前状态

- 维护版本：`2.5.110-142`，发布标签 `released/2.5.110-142`，包 `yanhaidao-wecom-2.5.110-142.tgz`（npm shasum `760c6b084fbfd1ae1373894de83586f1973e7bea`；SHA-256 `7156af89cef2dcb269aea0e688ec34713c40e7d0ae245be3c740ca196bbb6ce5`）。
- 生产环境：OpenClaw **2026.7.1**；仓库 devDependency 与 peer 基线仍为 **2026.6.11**（`node_modules/openclaw`），代码需双版本兼容。
- 企业微信 Bot SDK：`@wecom/aibot-node-sdk` **1.0.7**（固定版本）。
- 远端纪律：**只推 `fork`（git@github.com:liny90626/wecom.git），绝不推 `origin`（上游 YanHaidao）**；提交邮箱已固化为 `liny90626@users.noreply.github.com`（GH007 教训）。
- 发版纪律：打包、打 tag、推远端、更新发布文档均需用户明确批准。
- 测试基线：42 文件 / 405 测试全绿；核心回复套件无缓存复跑 170 测试全绿；`npm run build`、`npx tsc --noEmit`、`npm run verify-dist`、`node scripts/patch-wecom-b3-merge-thinking.mjs --check`（B1/B2/B3 链）、`git diff --check` 全部通过。
- `reply.test.ts` 头部有 `vi.setConfig({ testTimeout: 30_000 })`：该套件 fake-timer 密集，全量并发冷缓存下墙钟可超默认 5s（历史上多次假超时、失败集合随机）。不要改回全局 timeout，也不要因单次全量超时怀疑回归——先单文件复跑。

## 2. v142 事件档案（为什么改成现在这样）

本版处理四类相互关联的问题：

1. **企微进度 ACK 反向阻塞模型流**：OpenClaw 会等待 reasoning/Fast 回调；企微 SDK 又按同一 `req_id` 串行等待 ACK。插件此前直接等待进度网络请求，ACK 变慢时可能拖住模型事件消费并触发 OpenClaw idle timeout，表现为思考气泡或半截正文后中断。
2. **解除阻塞后出现进度/final 竞争**：简单 fire-and-forget 会让多个进度并发写同一 reply stream，final 也可能越过仍在途的进度。
3. **长任务耗时显示 `0s` 或重置**：旧时钟从首个正文预览开始，没有计入此前的工具调用和推理耗时。
4. **Fast 延后回复与真实失败混淆**：OpenClaw 将活跃回合转后台时，Fast auto-off 可能被误判为无正文中断；被新消息接管的旧回合也可能产生迟到失败提示。

修复（详见 `changelog/v2.5.110-142.md`）：reasoning/Fast 回调改为非阻塞登记；插件内部用单一 Promise 尾队列串行投递，并只保留最新待发 reasoning 快照；所有 final 路径先停止新进度并执行最多 500ms 的有界封口，持续阻塞则取消待发进度并沿用主动推送兜底；接管 abort 后旧回合静默；任务时钟从 ReplyHandle 创建时开始且最低显示 1s，健康流每 15 秒推进状态；Fast deferred 与真实空回合分别处理。没有新增 OpenClaw 重试、轮询或强制中断。

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

`[wecom-b3] dispatch-absorbed-by-active-run`（消息被并入，用户收到提示）· `dispatch-deferred-no-visible-reply`（回合转后台）· `progress-delivery-failed`（单次进度投递失败，模型流不受阻）· `progress-drain-timeout`（500ms 封口超时，随后应走 final 兜底）· `pre-dispatch-run-drain(-result|-failed)` · `dispatch-init-conflict-handoff-retry` · `final-retry-failed ambiguous=true|false` · `final-retry-exhausted`（随后应有一次 fail-notice）· `final-retry-skip-superseded` · `[wecom-preview] expired-notice-deferred`（9 分钟挂起）· `expired-notice-failed`（任务未结算时下一分钟再试）。
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
- 500ms 是进度封口的有界等待，不会强杀已经进入 SDK 的 ACK；若 ACK 继续阻塞，final 仍需经过 ReplyHandle 既有 5.5s 等待后转主动推送。因此极慢网络下完整 final 可能稍迟，但不会再反向卡住 OpenClaw 模型事件流。
- 6.11 上“真空回合 + 有思考活动”现以静默/“（回复完毕）”收口而非报错（生产为 7.1，核心有 #100456 可见兜底，无影响）。
- ambiguous 补发存在有界重复风险（仅未确认分片、≤3 次）——刻意取舍，静默丢失代价更高。
- 被接管且“已可见”的旧 final 仍按 B3 丢弃，且核心的 pendingFinalDelivery 恢复副本会因“投递成功”被清除——这是 B3 设计语义，不是 bug。
- 观察 `final-retry-failed ambiguous=true` 频率：若高发，说明推送链路（WS 重连/ACK）不稳，优先查网络而非改重试参数。
- `monitor.integration.test.ts`、`sandbox-media.test.ts` 历史上环境耦合敏感（当前全绿）；全量失败先怀疑负载/环境，再怀疑回归。
- 发布 tarball 不入 git（*.tgz 未跟踪），以 changelog 打包记录的 shasum 为准。

## 7. 版本脉络备忘

`v118`（稳定基线）→ v119-135 开发线**未入主线** → `v136` 基于 v118 重建 → `v137` init-conflict 短重试 → `v138` 媒体+文字合并、接管排空 → `v139` OpenClaw 7.1 适配 + 投递抗丢失 → `v140` 未发布体验包 → `v141` routed-final 收口 + 持续长任务状态 + SDK 1.0.7 → `v142` 进度/模型流解耦 + final 有界封口 + 长任务时钟修正（当前）。
