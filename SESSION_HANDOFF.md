# SESSION HANDOFF - OpenClaw WeCom 插件维护

> 最后更新：2026-08-28
>
> 本文件只保留当前可执行信息。早期版本流水账、已经关闭的排查过程和旧测试数字不再重复；需要历史细节时查看 git log 与 changelog。

## 0. 先读结论

- 已发布基线：2.7.260-21，标签 released/2.7.260-21，已推送 fork。
- 自测统一只使用 OpenClaw 2026.7.1-2，不再运行双版本测试矩阵。
- 2.7.260-21 有两块内容：
  - **对抗式评审**：上一轮候选声称修好两个问题，逐条复现后两个都没修好，第二个还引入内容丢失；三项均已修复（详见第 2.0 节）。
  - **官方功能对齐**：补齐模板卡片出站能力、deferred 回合不再宣称完成、入站附件超限给出可操作提示。
- 当前验证结果：全量 58 个测试文件、759/759 通过（正常负载 185s；高负载 3338s 同样全绿）；typecheck、build、dist、B1、B2、B3、diff check 全部通过。
- goal.md 记录本轮结论与仍然开放的缺口，其中「入站视频首帧提取」和「生成 package-lock.json」是**明确不做**，不是遗漏；不要再删该文件。

## 1. Git 与发布边界

### 当前 Git 状态

- 分支：main
- HEAD：5e6b87c，与 fork/main 相同
- 维护远端：fork = git@github.com:liny90626/wecom.git
- 上游远端：origin = https://github.com/YanHaidao/wecom.git
- 允许推送的目标只有 fork；禁止向 origin 推送。
- 2.7.260-21 涉及的文件：
  - src/capability/card/{parser,manager}.ts 与两个测试（新增）
  - src/transport/bot-ws/reply.ts / reply.test.ts
  - src/transport/bot-ws/sdk-adapter.ts
  - src/runtime/reply-orchestrator.ts / reply-orchestrator.test.ts
  - src/app/account-runtime.ts / account-runtime.test.ts
  - src/shared/media-service.ts / media-service.test.ts、src/http.ts
  - src/types/runtime.ts、index.ts
  - package.json、src/version.ts、README.md、changelog/、goal.md、本文件

### 发布状态

- 版本号 2.7.260-21，包指纹见第 7 节，tag released/2.7.260-21 已推送 fork。
- origin 始终只读，从未推送。

## 2. 当前候选改动

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
2. 流仍健康但预览已冻结时，冻结之后的新正文可能要等到 final 才显示；后台推送目前只在流退休或 ACK 不可信时接管。
3. 回合前 120 秒内流就失效且此前没有成功预览时，后台通知存在窄场景被取消的可能。
4. ambiguous 主动推送重试仍有有限重复风险，当前上限为 3 次；这是“宁可有限重复，不静默丢答案”的明确取舍。
5. 真实 Windows、企业微信网关和客户端尚未在本候选上验收；网关模拟器不能代替真机验证。
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

- WeCom stream frame 预算：15360 bytes；final 单段上限约 5000 字符。
- 流式过程预览冻结阈值：约 5 分钟或 3000 字符。
- 长任务状态首格：回合开始后 8 分钟；正常状态网格每 60 秒。
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
OpenClaw: 2026.7.1-2
Vitest: 58 files / 759 tests passed (185s 正常负载 / 3338s 高负载，两次都全绿)
npx tsc --noEmit: passed
npm run build: passed
npm run verify-dist: passed
B1: READY
B2: READY
B3: READY
git diff --check: passed
~~~

高负载下的一次全量（load average 49 / 8 核）耗时 3086 秒，gateway-sim 的 30 秒墙钟用例超时；
负载回落到 5 后该文件隔离复跑 33/33 通过（868ms），随后全量 721/721 通过。
不要为掩盖负载抖动修改生产 timeout。

### 包指纹

~~~text
yanhaidao-wecom-2.7.260-21.tgz
size:        594,299 bytes
unpacked:    2,275,320 bytes
files:       252
npm shasum:  16afa1d857b9b357daf71451a1862e4b6964ba14
SHA-256:     fc47cf87cc603d49d72e6481ac855d11329692633289a273b410427e7985654c
~~~

重复打包 SHA-256 一致；隔离 npm install --omit=dev 后 @wecom/cli-linux-x64 可解析，二进制返回 wecom-cli 1.2.0。
包内含 dist/src/capability/card/，无测试文件、node_modules、credentials.enc 或 .encryption_key。

全量命令：

~~~bash
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

测试机负载较高时，fake-timer 套件可能超过默认墙钟预算；不要为了掩盖环境抖动修改生产 timeout。先隔离单 worker 复跑并记录断言类型。

## 8. 下一步与停止条件

### 现在不要做

- 不要删除 goal.md，它是本轮 review 的待办清单。
- 不要重置或覆盖当前工作区改动。
- 不要升级或切换 OpenClaw 版本。
- 不要打 tag 或推送远端（本轮未获授权）。
- 不要在没有用户拍板前动 goal.md 里 P0-1（模板卡片技能取舍）和 P0-2（完成标记）。

### 下一版发布时（需要用户明确批准）

1. 更新 package.json 与 src/version.ts（version.test.ts 会对账）。
2. 全量 typecheck / build / verify-dist / Vitest / B1 / B2 / B3 / diff check。
3. 打包并记录指纹，重复打包校验 SHA-256 一致。
4. 创建 released/<完整版本号> tag，只推 fork（git@github.com:liny90626/wecom.git），绝不推 origin。

### 改 reply.ts 时必看

B1/B2/B3 三个门禁脚本用**字面量匹配**校验硬化不变量，重命名局部变量就会让它们变红。
本轮把 const outboundText 改名成 composedOutboundText 后 B2 立刻 NOT_READY，已改回。
改动那一段前先跑 node scripts/patch-wecom-long-message.mjs --check。

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
