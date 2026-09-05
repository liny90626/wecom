# SESSION HANDOFF - OpenClaw WeCom 插件维护

> 最后更新：2026-09-05
>
> 本文件只保留当前可执行信息。2.7.260 时代的排查过程、门禁与测试数字已随代码一起退役；需要历史细节时查看 `git log`、`changelog/` 与 tag `released/2.7.260-26` 上的旧版本文档。

## 0. 先读结论

- **已发布 3.0.0-v1**：tag `released/3.0.0-v1`，与 main 一起推送 fork（核对见第 6 节）。生产此前跑 2.7.260-26（tag `released/2.7.260-26`），升级与真机验收步骤见 `changelog/v3.0.0-v1.md` 第六节。
- **main 已切换到上游 v3.0.0 基线**：YanHaidao/wecom `v3.0.0`（origin `133773f`）本身是以腾讯官方 `WecomTeam/wecom-openclaw-plugin` 2026.8.17（commit `3b1cbe3`）为主线的重建。2.7.260 的 Bot WS 车道（`src/transport`、`src/runtime`、`src/capability/bot`）、B1/B2/B3 门禁脚本、`openclaw-sdk-imports.test.ts` 守卫都不在这棵树里了，见第 2 节。
- 3.0.0-v1 相对 `released/2.7.260-26` 的提交：
  - `7c167ca` sync：采纳 v3.0.0 + Codex 的 2026.7.1-2 兼容适配（devDependency 钉回 7.1-2、setup contract 可选、账号合并、字节切分/节奏移植等）。
  - `6e9c1e0` fix(bot-ws)：本轮复现并修复的 4 项稳定性缺陷 + 2 项小修，见第 3 节。
  - 交接文档重写、`release: 3.0.0-v1`（版本号、changelog、README 发版章节、包指纹）。
- 兼容目标：OpenClaw `2026.7.1-2`（生产）与最新稳定版 `2026.9.1`（npm `latest`）。`npm run compat:check 2026.7.1-2 2026.9.1` 两条线 typecheck + 全量测试均 PASS（见第 6 节）。
- 官方仓库 `WecomTeam/wecom-openclaw-plugin` 的 main HEAD 仍是 `3b1cbe3`（2026-08-17），与上游 v3.0.0 记录的基线相同——用户说的「官方有更新」已通过上游 v3.0.0 全量吸收，官方侧没有更新的提交可再借鉴。
- 用户在 2.7.260-26 上反馈的「agent 说文件发了，实际没到，再要一次才发」：**离线未能复现出插件侧的必然机制**，需要现场日志定位，见第 4 节。新基线上已堵住两条会造成同一体验的路径（第 3 节 ④⑤）。
- 版本约定（用户 2026-09-05 批准）：包版本在上游版本后追加 `-vN`，即 `3.0.0-v1`、`3.0.0-v2`…；tag `released/<版本>`，只推 fork。

## 1. Git 与发布边界

- 分支：main。维护远端 **fork = git@github.com:liny90626/wecom.git**（唯一允许推送的目标）。
- 上游远端 **origin = https://github.com/YanHaidao/wecom.git**：只 fetch / 对账，**禁止推送**。
- 官方仓库 `https://github.com/WecomTeam/wecom-openclaw-plugin.git`：只读参考。上游文档约定的 `official` 远端本仓库尚未配置（`npm run upstream:check` 需要它且 push URL 须设为 `DISABLED`）；本轮用临时 clone 对账。
- 提交作者邮箱用 `liny90626@users.noreply.github.com`（GH007）。真实 apikey / botId / secret 不得进仓库、日志与文档。
- tag 命名 `released/<完整版本号>`。**不要**打 `v*.*.*` 形式的 tag：上游的 `.github/workflows/release.yml` 以它触发 npm 发布，虽有 `github.repository == 'YanHaidao/wecom'` 守卫，也没必要去碰。
- 发版按批次：修复先提交 main，用户在真机积累反馈后一起发；每修完一个问题不必追问「要不要发版」。
- 打包、打 tag、改版本号 / changelog / README 发版章节、推送远端：**都要用户明确批准**。发版按批次：平时修复只提交 main，积累真机反馈后一起发。

## 2. v3.0.0 基线与 2.7.260 的差别（改代码前必读）

### 2.1 架构

Bot WS 主链路现在是官方的单文件车道：

```
src/monitor.ts monitorWeComProvider
  → prepareWeComMessage（解析 / 群策略 / DM 策略 / 下载入站媒体）
  → chat-queue（同 account:chatId 严格串行）
  → processWeComMessageNow → buildMessageContext → routeAndDispatchMessage
      dispatchReplyWithBufferedBlockDispatcher
        onReplyStart → thinking 帧 <think></think>
        deliver      → 媒体先主动发送（sendMediaBatch）→ 正文写气泡（首帧预算内）
      processTemplateCardsIfNeeded → finishThinkingStream（finish 帧 / 主动推送）
```

其他入口：`src/channel.ts`（Channel 定义、outbound sendText/sendMedia、gateway.startAccount）、`src/webhook/*`（Bot Webhook 车道）、`src/agent/*`（自建应用 XML 回调车道，含 upstreamCorps）、`src/addon/*`（诊断 CLI、安全审计、能力矩阵）、`src/cli/*`（wecom-cli 工具）、`src/capability/doc|calendar`（增强工具）。

### 2.2 2.7.260 有、新基线没有的行为（有意接受的代价，需要时单独立项）

| 2.7.260 行为 | 新基线现状 |
| --- | --- |
| 长任务心跳：8 分钟状态帧、工具阶段 90 秒沉默看门狗、死窗后每 20 秒推送正文 | 没有。流窗口约 6 分钟关闭后气泡冻结在最后一帧，答案在 final 到达时整体主动推送 |
| 思考窗口随推送车道携带、过程步骤气泡 | 没有。只有 `<think></think>` 占位与正文 |
| 新消息接管旧回合（supersede / abort run） | 没有。同一会话严格串行，后一条消息等前一条跑完 |
| final/block 双形状字节级去重（mergeReplyText / respaceLikeCore） | 插件直接累加 `payload.text`；依赖核心 `directlySentBlockKeys` 过滤重复的 final 文本 |
| 运行时上下文围栏（5bcbd05：入站转义、preamble/reasoning 剥离） | 未移植。新基线没有 `before_prompt_build` 钩子，preamble/reasoning 不进气泡；入站文本不转义 |
| 默认放行 `~/Desktop ~/Documents ~/Downloads ~/Movies ~/Pictures` 作为出站媒体根 | 只放行 SDK 默认根（tmp、media、workspace、sandboxes、canvas）+ stateDir + 配置的 `channels.wecom.mediaLocalRoots`。**运维动作**：agent 若把文件写到这些目录，需在配置里补 `mediaLocalRoots` |
| B1/B2/B3 字面量门禁、`openclaw-sdk-imports.test.ts` | 已删除（目标文件不存在）。双版本兼容靠 `npm run compat:check` 在两条线上真跑 typecheck + 测试 |
| 8.x 需放行 `plugins.entries.wecom.hooks.allowConversationAccess` | 不再需要（没有会话钩子） |
| 卡片回调渲染成含选项原文的可读文本（describeTemplateCardEvent） | 官方 `buildTemplateCardEventText` 输出结构化字段文本（question_key / option_id），不还原选项原文 |

保留下来的：Agent 车道字节切分（2048 B）与 1100 ms 节奏、compat 检查脚本、多账号 / upstreamCorps / 动态 Agent / 模板卡片 / wecom-cli 与 16 个 Skills。

### 2.3 Codex 兼容适配的核对结果（对照两条线的 dist）

| 适配 | 核对 |
| --- | --- |
| devDependency `openclaw@2026.7.1-2`，peer `>=2026.7.1-2` | 正确；compat 检查另装 9.1 |
| `setupContract` 由 `defineChannelSetupContract` 存在与否决定，`setup` 适配器同时提供 | 7.1-2 无该工厂；9.1 的 `channels add` / doctor 用 `setupContract ?? plugin.setup`，两者并存无冲突 |
| `registerSecurityAuditCollector` 改在 `registerFull` 里可选调用 | 两条线的 plugin api 都有该方法；7.1-2 没有 `registerCapabilities` 入口 |
| CLI 描述符去掉 `machineOutput` | 本轮改回：用非字面量对象保留（9.1 识别 `--json`，7.1-2 类型不检查多余字段） |
| `createAccountListHelpers` 不再传 `omitKeys/nestedObjectKeys`，本地合并 groups | 两条线运行时其实都支持这两个选项；本地实现语义等价（omit accounts/defaultAccount，groups 浅合并），保留 |
| 账号快照去掉 `lifecycle` 字段 | 两条线的 `ChannelAccountSnapshot` 类型都没有 `lifecycle`；monitor 仍在 setStatus 里传它，类型为 Record，无害 |
| `readResponseWithLimit` 用 `chunkTimeoutMs` | 7.1-2 只有 `chunkTimeoutMs`（无 `timeoutMs`），9.1 两者都有；语义从总超时变成空闲超时，可接受 |
| Bot WS 媒体 `sentMediaUrls` 幂等 | 7.1-2 与 9.1 的 block 分发都 `extractMediaDirectives: false`，正常只有 final 带 mediaUrls；幂等是防御，无副作用 |

## 3. 本轮修复（先复现再修，提交 6e9c1e0）

复现载体：`src/monitor.gateway-sim.test.ts`——用内存网关驱动 `monitorWeComProvider` 全链路（假 WSClient + 假核心分发器），断言用户实际收到的帧与推送。修复前 6 条用例 4 条红，修复后全绿。

| # | 缺陷（新基线原状） | 复现用例 | 修复 |
| --- | --- | --- | --- |
| ① | 长回答按全文写帧，48 KB 的答案发出 5 帧超过官方 `stream.content` 20480 字节上限；窗口过期后又整段一条推送 | gateway-sim「keeps every stream frame within the documented content ceiling…」「pushes a long answer in gateway-sized chunks…」 | 一帧预算 `STREAM_FRAME_MAX_BYTES=15360`（官方上限的 75%，2.7.x 现网值）：气泡冻结在首帧，余量在 finish 时按 `ACTIVE_PUSH_CHUNK_CHARS=3500` 分片主动推送，条间用既有 1100 ms 节奏 |
| ② | finish 帧 ACK 丢失（SDK 5 秒超时）→ 抛错 → `finish_after_failure_failed`，答案静默丢失 | 「falls back to an active push when the finish frame loses its ACK」 | finish 帧任何失败都改走分片主动推送；ACK 丢失时帧可能已落地，宁可有限重复不丢答案（日志 `stage=finish_frame_failed fallback=active_send`） |
| ③ | 846605（invalid req_id）未识别为流拒绝，同上丢答案 | 「treats 846605 (invalid req_id) like an expired window…」；message-sender.test「maps errcode 846605…」 | `toStreamRefusal`：846605/846608 都映射为 `StreamExpiredError`（errcode 保留在异常上） |
| ④ | `outbound.sendMedia`（message 工具）失败时只给用户发一条提示并**返回成功**，模型以为文件已发 | channel.test「fails the message tool when the upload fails…」「…rejects the file size」 | 三条失败路径（Bot WS、Agent HTTP 兜底、上下游）都先通知用户再抛错，工具拿到失败 |
| ⑤ | 出站文件不在白名单内时提示「无法处理文件…请稍后再试」，重试无用 | monitor.media.test「points at mediaLocalRoots…」 | 识别本地回退实现的 `not under an allowed directory`，给 `mediaLocalRoots` 配置提示 |
| ⑥ | `wecom diagnose --json` 在 9.1 上丢失 machineOutput 标记 | cli.test「marks `wecom diagnose --json` as machine output…」 | 非字面量描述符保留该字段 |

不变量（改 `src/monitor.ts` 前先跑 gateway-sim）：
- 任何一帧 `stream.content` ≤ 15360 字节；气泡首帧不变时不重绘（`state.streamedText`）。
- `finishThinkingStream` 只在 finish 帧确认成功且余量为空时结束；否则余量 / 全文经 `pushMarkdownChunks` 出门。
- 主动推送分片 ≤ 3500 字符且 ≤ 15360 字节；15 KB 主动推送上限没有现网证据，3500 字符是已验证值。

## 4. 用户反馈：2.7.260-26「说文件发了，实际没到」——排查状态

- 结论：读完 -25→-26 的全部媒体相关改动（`media.ts` 改用 `readLocalFileFromRoots`、`reply.ts` 收尾与 20 秒正文推送、`outbound.ts` 字节切分），**没有找到一条必然让文件静默消失的代码路径**：final 的媒体循环在正文逻辑之前执行，失败会把「媒体发送失败：<路径> (原因)」追加进 final；`message` 工具路径失败会抛错。
- 与现象相符但无法离线证实的候选：① 出站白名单拒绝（应伴随「媒体发送失败」文案）；② 模型只说「已发送」而没写 `MEDIA:` 行（模型行为，重试时才写）；③ 死窗后答案正文已按 20 秒推送到达，final 的媒体上传遇到 WS 抖动失败，随后追加的失败行推送也失败——用户只看到「已发送」的正文；④ Windows 路径规范化差异（仅当生产在 Windows 且路径大小写 / 斜杠不一致）。
- **需要现场日志**（一次失败的那轮）：`[wecom-b3] ... final` 相关行、`媒体发送失败`、`[wecom-outbound] sendMedia:` 行、`active-push-failed`、`stream-final-skip-unreliable`，以及当时模型是走 `MEDIA:` 指令还是 `message` 工具、生产机 OS。
- 新基线上对应的两条路径已收口：④ 工具路径失败不再返回成功；⑤ 白名单拒绝有可操作提示（第 3 节）。真机复验时若再出现，日志关键行为 `stage=media_failed`、`stage=media_batch_failed`、`[wecom][outbound] ... kind=media`。

## 5. 架构与排查入口（新基线）

- 日志统一为 `[wecom][flow] trace=<脱敏 id> stage=<阶段>`：`inbound_received → inbound_parsed → policy_allowed → media_prepared → queue_immediate|queued → route_resolved → session_recorded → agent_dispatch_start → agent_reply_start → agent_reply_chunk → media_batch_start|media_failed → agent_dispatch_complete → outbound_start|outbound_delivered|outbound_failed → message_complete|message_failed`。
- 流拒绝：`stage=stream_expired`（846605/846608，之后 `transport=active_send reason=stream_expired`）；finish 帧其他失败：`stage=finish_frame_failed fallback=active_send`，随后 `reason=finish_unacked`；长回答余量：`reason=frame_budget chunks=N`。
- 生命周期：`[wecom][lifecycle] stage=client_create|socket_connected|authenticated|socket_disconnected|reconnecting|blocked`。被踢下线（`reason=duplicate_connection`）与认证失败（`reason=authentication_failed`）会让 Promise 保持 pending 以阻止框架自动重启——排查「插件不重连」先看这两行。
- 关键常量（`src/const.ts`）：`REPLY_SEND_TIMEOUT_MS=15000`（SDK 自身 ACK 超时 5000）、`MESSAGE_STATE_TTL_MS=10min`、`STREAM_FRAME_MAX_BYTES=15360`、`ACTIVE_PUSH_CHUNK_CHARS=3500`、媒体 10/10/2/20 MB 与官方一致。
- 出站媒体白名单：`getExtendedMediaLocalRoots`（monitor.ts）= SDK `getAgentScopedMediaLocalRoots` + stateDir + `mediaLocalRoots` 配置；`message` 工具路径只用核心传入的 roots（7.1-2 与 9.1 都传 `getAgentScopedMediaLocalRoots(cfg, agentId)`，含 agent 工作区）。

## 6. 当前验证证据

~~~text
typecheck（仓库 node_modules，7.1-2）: 0 错误
vitest: 29 / 29 files，94 / 94 tests（含 gateway-sim 6 条）
npm run compat:check 2026.7.1-2 2026.9.1: 两条线 typecheck PASS、94/94 PASS（9.1 为 file-access-runtime 补类型 shim）
npm run build / verify-dist: PASS
git diff --check: clean
真实企业微信验收: 未做（OFFICIAL_CAPABILITY_ACCEPTANCE.md 全部 NOT RUN）
~~~

### 包指纹（3.0.0-v1）

~~~text
yanhaidao-wecom-3.0.0-v1.tgz（仓库根目录，.gitignore 忽略）
size:        564919 bytes
unpacked:    2100003 bytes
files:       286
npm shasum:  b4215e04adcba5d087fdc948a8c9ddb1813ca78e
SHA-256:     9870de680d836daa10d7c6d3d83d9ae513d5684c43f7c6a19d6e896a1b06778c
~~~

重复打包字节一致；包内无测试文件、无凭据、无本文档。推送核对：`git rev-parse fork/main` 与 HEAD 一致，`git ls-remote --tags fork` 含 `released/3.0.0-v1`。

全量命令：

~~~bash
npm run compat:check 2026.7.1-2 2026.9.1   # 两条线各一遍 typecheck + 全量 vitest（工作区在 ~/.cache/wecom-openclaw-compat/）
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
npm run build && npm run verify-dist
git diff --check
~~~

注意：不要在 compat 工作区里用 `npx tsc`（无 `.bin`，会跑到过时的 `tsc` 包并假报 0 错误）。

## 7. 发版步骤（3.0.0-v1 已按此执行；下一版复用，需用户明确批准）

1. `npm version <版本> --no-git-tag-version`（`src/version.ts` 运行时读 package.json，不用改）。
2. 新增 `changelog/v<版本>.md`，更新 `changelog/README.md` 索引与 README「当前版本」行。
3. 跑第 6 节全量命令；`npm pack` 到仓库根目录，记录 size / shasum / SHA-256，重复打包校验一致，把指纹写进 changelog 与本文档。
4. `git commit -am "release: <版本>"`，`git tag -a released/<版本> -m "WeCom plugin <版本>"`，`git push fork main && git push fork released/<版本>`。**绝不推 origin，不打 `v*` 标签。**
5. 真机安装：把 tgz 复制到本地磁盘再 `openclaw plugins install "npm-pack:<本地路径>"`（映射盘 / NAS 会报 archive changed during validation）。3.0.0-v1 安装后先做：发文件（`MEDIA:` 与 message 工具各一次）、长回答（> 6000 汉字）、6 分钟以上长任务、文件不在白名单目录；结果决定长任务心跳是否需要单独立项移植。

## 8. 仍然开放的边界与风险

1. 长任务体验相对 2.7.260 是倒退（第 2.2 节）：约 6 分钟后气泡不再更新，直到 final 一次性推送；没有心跳，也没有过程步骤。真机若不能接受，需要单独立项把心跳 / 死窗推送移植到 `monitor.ts`。
2. 同会话严格串行：长任务期间同一用户的新消息要排队到前一轮结束。
3. ACK 丢失时的 finish 兜底可能造成一次重复（气泡若已收尾，推送会再发一遍）；这是有意的取舍。
4. 主动推送 15 KB 上限、`chunkMarkdownText` 在围栏边界的裁切行为只有 2.7.x 现网旁证，未在新基线真机验证。
5. Windows 真机、真实企业微信网关 / 客户端、上下游企业链路、模板卡片交互均未在新基线验证；`OFFICIAL_CAPABILITY_ACCEPTANCE.md` 全部 NOT RUN。
6. 官方基线同步：`UPSTREAM_BASELINE.json` 记录 `3b1cbe3` / 2026.8.17，与官方 HEAD 一致；以后对账用 `npm run upstream:check`（先按 `OFFICIAL_PLUGIN_MIGRATION.md` 配好只读 `official` 远端）。
