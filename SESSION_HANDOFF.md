# SESSION HANDOFF — OpenClaw WeCom 插件维护交接

> 最后更新：2026-07-25（v2.5.110-146 已发布）。新会话开工前先读本文件、`README.md`、`changelog/README.md` 与最新版本简报。

## 1. 当前状态

- 当前正式版本：`2.5.110-146`，发布标签 `released/2.5.110-146`，包 `yanhaidao-wecom-2.5.110-146.tgz`（209,307 bytes；139 文件；npm shasum `93f57743948c3ba38b879bf2d319cf82d22ad080`；SHA-256 `6455e9883285b543014b108563acbf1b2db27d38b45deb9f51086686b6b07daf`）。
- 开发分支 `fix/v146-inbound-delivery-stability` 已 fast-forward 合入 `main` 并推送 `fork`。
- 标签状态：`released/2.5.110-144` 已于 2026-07-24 从本地与 `fork` 删除；v144 变更记录仅作历史归档，其修复已由 v145 继承，不要重新发布 v144。
- 生产环境：OpenClaw **2026.7.1**；仓库 devDependency 已同步升级到 **2026.7.1**（`node_modules/openclaw`），`peerDependencies` 仍为 `^2026.6.11`，**代码必须继续双版本兼容**。
- 企业微信 Bot SDK：`@wecom/aibot-node-sdk` **1.0.7**（固定版本）。
- 远端纪律：**只推 `fork`（git@github.com:liny90626/wecom.git），绝不推 `origin`（上游 YanHaidao）**；提交邮箱已固化为 `liny90626@users.noreply.github.com`（GH007 教训）。
- 测试基线：43 文件 / **476 测试全绿**；`npm run build`、`npx tsc --noEmit`、`npm run verify-dist`、B1/B2/B3 检查链（三项 READY）与 `git diff --check` 全部通过，全部在 OpenClaw 2026.7.1 上完成。
- `reply.test.ts` 头部有 `vi.setConfig({ testTimeout: 30_000 })`：该套件 fake-timer 密集，全量并发冷缓存下墙钟可超默认 5s。不要改回全局 timeout；单次全量超时先单文件复跑再怀疑回归。
- 涉及 3 秒释放等待的 dispatcher 用例已全部改为 fake timers；新增 busy 相关用例时**必须**用 `vi.useFakeTimers()` 并在 `finally` 里 `vi.useRealTimers()`，否则会污染后续用例（已发生过一次超时）。

## 2. v146 事件档案（为什么改成现在这样）

以 `released/2.5.110-118` 的简单、低等待路径为参照，分两轮完成。

**第一轮（入站合并与生命周期）**：媒体+文字合并不完整、pending 提前接管 active、WS runtime owner 生命周期断裂、busy 重试把 `fallbackEligible` 也包含进来、第二轮 busy 提示绕过失败兜底。

**第二轮（对抗式复核，相对 v118 的退化）**：

1. **首反馈延迟**：`activate`（含占位气泡）被推迟到 prepare + 预派发排空 + 接管排空之后，文件消息在下载全程无气泡。→ 拆出 `startPlaceholder`，入站被接受即开气泡；媒体帧进入合并窗口前也先确认，合并后的回合复用同一气泡。
2. **消息静默丢失**：prepare 期间被接管的 pending 消息整条丢弃（正文+附件），却提示“合并思考”。→ 并入后继消息（同发送者、普通消息类型），不可合并时改提示“尚未开始处理，请重新发送”。
3. **提示与事实不符**：被 OpenClaw steer/入队的消息被告知“确认新指令未执行后再重试”，重发即重复执行。→ 该分支改回“已并入当前任务”，“未执行”只留给核心确实拒绝的路径。
4. **空 final 清空气泡**：企微流式帧携带整条内容，`finish=true, content=""` 会覆盖用户正在看的进度。→ 以最后可见预览收口。
5. **7.1 冻结中止导致拒收**：终态提交后 `freezeAbort` 让中止恒被拒，健康长任务投递期间的新消息被直接拒收。→ 增加最长 3 秒（150ms 轮询）释放等待，仍在既有 5 秒屏障内。

## 3. OpenClaw 7.1 核心机制速查（源码级已验证，本轮在 7.1 实测）

- **会话准入错误（run 前抛出，可安全重试一次）**，插件按文案匹配（`src/shared/reply-errors.ts`，有逐字单测）：
  - `reply session initialization conflicted for <sessionKey>`（6.11/7.1 皆有）
  - `Session "<sessionKey>" changed|was deleted while starting work. Retry.`（7.1 新增）
  - `timed out draining work before reply session rollover: <sessionKey>`（7.1 新增）
- **abort 冻结**：`runAgentTurnWithFallback` 提交终态时调用 `replyOperation.freezeAbort()`，此后 `isReplyOperationAbortable` / `isEmbeddedRunHandleAbortable` 恒为 false，`abortEmbeddedAgentRun` 直接返回 false（6.11 没有这个可中止性检查，所以本地无法复现——这正是必须用 7.1 自测的原因）。`aborted:false` 通常代表**健康 run 正在投递**，不是卡死。
- **forceClear 危险**：无属主校验，会把健康 run 打成 `run_failed`（用户会收到核心英文“Something went wrong…”），且不取消后端。**插件已彻底不用。**
- **busy 结果分诊（已核对核心源码）**：
  - `noVisibleReplyFallbackEligible=true` + 零计数 + 无活动 + 仍有 active run ⇒ 核心把消息 steer/入队进了运行中的 run（`runReplyAgent` 早返回）。**消息已被接收**，只能提示“已并入当前任务”，绝不能重投。
  - **flagless** zero-output（无 `noVisibleReplyFallbackEligible`）⇒ `finishReplyOperationBusyDispatch`，入站 `dedupeDisposition:"release"`，**确实没有进入回合**，允许一次 500ms 重试。
  - 默认 queue mode 是 `steer`（`resolveQueueSettings` 末位默认值）；活跃且 streaming 时 steer，活跃不 streaming 时 enqueue-followup，两者都返回零计数。
- **abort 冻结后的 owner 退出**：OpenClaw 可能不接受 abort，但 adapter stop/reload 仍须使旧 ReplyHandle 本地失效、停止 timer，并等待真实 core Promise 结算后释放 owner。

## 4. 生产观察关键词

`[wecom-b3] inbound-session-metadata-deferred` · `dispatch-pending-register` · `pending-inbound-adopted`（被接管消息已并入后继消息）· `pending-inbound-dropped`（跨发送者/事件回合，未合并，已提示重发）· `pre-dispatch-run-drain(-result|-failed)` · `pre-dispatch-run-release-wait released=true|false`（7.1 冻结中止后的有界等待）· `pre-dispatch-run-busy`（等待超时后仍拒收）· `dispatch-handoff-retry reason=init-conflict|busy-result`（仅一次）· `dispatch-absorbed-by-active-run`（已并入运行中任务）· `dispatch-busy-not-accepted`（核心确实拒绝）· `dispatch-deferred-no-visible-reply` · `progress-delivery-failed` · `progress-drain-timeout` · `*-wait-timeout` · `final-retry-failed ambiguous=true|false` · `final-retry-exhausted` · `final-retry-skip-superseded` · `[wecom-ws] merged media+text` · `duplicate pending media ignored`。

若 `pre-dispatch-run-release-wait released=false` 频繁出现，说明旧任务长期占住会话（>3s 仍未释放），优先查 OpenClaw active run/诊断日志，**不要在插件侧 forceClear**。

## 5. 禁改事项（每条都对应真实事故）

1. **不要恢复 forceClear / 分钟级等待 / 重试阶梯 / per-peer 熔断器 / synthetic thinking**（v132-v135 灾难线）。
2. **不要把 ambiguous 推送失败改回“不重试”**——会复发 v139 问题1（答案永久静默丢失）。重试必须复用**失败现场的同一 retryRequest 身份**（text/marker/limits）。
3. **不要给纯思考预览置 `visibleReplyStarted`**——判定依据是 `bodySourceText` 字段**存在性**（可为空串），不是真值。
4. **不要在 flag-empty 分诊前删掉 abort 守卫**、不要让被接管 handle 产生任何合成 final。
5. **`runFinalPushRetry` 的接管抑制要在执行点重算**（`supersededByNewInbound && visibleReplyStarted && delivered>0`）。
6. 最终回复保持被动 `replyStream` 路径；不动 12000 字节上限；预览冻结 5 分钟受微信 ~6 分钟流窗硬限制约束，9 分钟只作用于 `PREVIEW_EXPIRED_NOTICE_MIN_TASK_MS`。
7. **不要在 OpenClaw reasoning/Fast 回调中重新直接等待企微网络请求**（v142 反向背压）。
8. **所有跨请求全局状态都必须带完整作用域或属主身份**；注销必须校验原注册对象。
9. **不要重新合并 pending 与 active 注册时序**：新消息必须先证明旧 run 可释放，才能 supersede active handle；busy 拒绝路径必须保留旧 final。
10. **不要把 `retryFlaglessBusy` 扩大到 fallbackEligible/deferred**：`fallbackEligible` 意味着消息**已被核心接收**（steer/入队），重投＝重复执行。
11. **不要提前释放 runtime owner，也不要允许旧 reply 使用 replacement push handle**。
12. **不要删除媒体 `dedupeAliases` 或群聊 merge key 中的 `senderId`**。
13. **不要把 `startPlaceholder` 合回 `activate`**（v146 第二轮）：占位气泡必须在入站被接受时立即发出；`activate` 仍须留在确认接管之后，因为它会作废上一代的 pending final retry——提前执行会误杀上一条消息还没送达的答案。
14. **不要让被接管的 pending 消息直接丢弃**：正文/附件必须并入后继消息；合并**必须**限制在同一 `senderId` 且双方均非 event/welcome，跨成员合并会串联不同人的私事。
15. **不要把空 final 写成 `content=""`**：企微流式帧是整条覆盖，必须用最后可见预览收口。
16. **不要删掉 `pre-dispatch-run-release-wait`**：7.1 每次长任务收尾都会拒绝中止，去掉它就会退回“每个长任务后的下一条消息被拒收”。

## 6. 已知边界与待办观察

- 媒体在前仍保留 1 秒合并窗口，但占位气泡已在窗口开始时显示，用户不再面对静默等待。
- 群聊中不同成员的消息不合并内容；被顶掉的一方会收到“尚未开始处理”提示，需要重新发送。
- 单条回合只有第一个附件成为 `MediaPath`；文件+文件合并保留最新文件。
- 释放等待上限 3 秒，超时仍会拒收新指令（提示“确认新指令未执行后再重试”），这是明确取舍。
- 单个 handoff/drain 最长等待 5 秒；只在存在 pending/active 冲突时触发。
- 本地依赖现在就是 7.1，但**真机（企微网关）体验仍未做**：发布后需重点体验长任务、文件+文字、回复途中插入新消息三条链路。
- 暖会话不再等待 metadata；冷会话只等待 1 秒。
- ambiguous 补发存在有界重复风险（仅未确认分片、≤3 次）——刻意取舍，静默丢失代价更高。
- 被接管且“已可见”的旧 final 仍按 B3 丢弃，这是 B3 设计语义，不是 bug。
- `observedReplyDelivery` 是 OpenClaw 对已提交 source reply 的证明，不是“开始尝试”。
- `monitor.integration.test.ts`、`sandbox-media.test.ts` 历史上环境耦合敏感（当前全绿）。
- 发布 tarball 不入 git（*.tgz 未跟踪），以 changelog 打包记录的 shasum 为准。

## 7. 版本脉络备忘

`v118`（稳定基线）→ v119-135 开发线**未入主线** → `v136` 基于 v118 重建 → `v137` init-conflict 短重试 → `v138` 媒体+文字合并、接管排空 → `v139` OpenClaw 7.1 适配 + 投递抗丢失 → `v140` 未发布体验包 → `v141` routed-final 收口 + SDK 1.0.7 → `v142` 进度/模型流解耦 → `v143` 暖会话 metadata 解阻塞 + 依赖安全补丁 → `v144` 外部答案成功后的旧流静默结算 → `v145` retry/keepalive/注册表/source 生命周期与作用域闭环 → `v146` 入站即时确认、被接管消息并入、提示与事实对齐、7.1 冻结中止有界等待（当前版本，开发依赖同步到 2026.7.1）。
