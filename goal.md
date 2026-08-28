# goal.md — 对抗式评审与官方功能对齐

> 建立时间：2026-08-28
> 对照基准：官方仓库 `WecomTeam/wecom-openclaw-plugin`，HEAD = `3b1cbe3`（`2026.8.17`，最后一次功能提交 `34452cd` 2026-08-17）。
> 本轮首次拿到官方**完整 TypeScript 源码**（15,627 行），此前只有 npm 包里的 dist。
> 自测口径不变：OpenClaw `2026.7.1-2`。

---

## 一、本轮已完成

### 1.1 对抗式评审：`2.7.260-20` 之后候选的三处问题（已修复）

候选原本声称修好两件事，逐条复现后**两件都没修好，第二件还引入了内容丢失**。

**① 冻结状态定时器仍会 0ms 空转。** 候选加了 5 个守卫，漏掉「流可写但 ACK 一直不回」这条路径。实测 200 次 timer 步进出现 **98 个 0ms 定时器**，只推进 79.6 秒虚拟时间，`replyStream` 调用 **297 次**（约 3.7 次/虚拟秒，设计是 60 秒 1 帧）。

根因是车道语义不一致：本车道的状态槽只在**确认送达**时消费，而 `sendPlaceholder`、`maybeSendPreviewExpiredNotice` 都是**派发即消费**。修复：`startPreviewStatusInterval` 增加 `minDelayMs`，「跑完一轮之后」的两个重挂点传 `LONG_TASK_STATUS_INTERVAL_MS`，冻结时首挂仍传 0。修复后 0 个 0ms 定时器，200 步覆盖 2.6 小时虚拟时间。

> 先试过「派发即占用槽位」的对齐写法：会把死流下推送车道的接管**推迟整整一分钟**（8:00 静默到 9:00），5 条既有用例变红，已放弃。**不要再走这条路。**

**② `closeDeferred` 不再关闭企微流。** 基线发 `replyStream(<用户已看到的文本>, finish=true)`，候选什么都不发，气泡整窗口期停在「正在生成」。修复：改走既有 `closeOpenedStreamSilently(lastPreviewText)`，编排层补 `await sealProgress()`。

**③ `closeDeferred` 静默丢正文。** 两段 block、第一段送达后窗口关闭时，基线推 `继续输出：\n\n第二段未送达的尾巴。`，候选推送为空。修复：`closeDeferred` 返回 `boolean`，回合仍有未送达正文时返回 `false`，落回既有 final 通道。

候选原有的两条 deferred 用例**去掉生产改动照样通过**、不具判别力，已改写。

### 1.2 模板卡片出站能力（原 P0-1，选项 B）

官方 `template-card-parser.ts`(731) + `template-card-manager.ts`(295) 已移植为 `src/capability/card/{parser,manager}.ts`，三个接入点全部接上：

- **抽取与发送**：final 文本里的 ```json 卡片块被抽出、按企微 API 归一化后经 `sendMessage(msgtype: template_card)` 单独推送，正文只留剩余文字。
- **流式遮罩**：`renderPreviewFrame` 统一遮罩——已闭合的卡片块替换为占位文案，未闭合的尾巴截断。放在这一层而不是某个调用点，是为了让正文预览、冻结状态、超时冻结三条预览车道行为一致。
- **交互回调**：`template_card_event` 先更新卡片本身（禁用控件、提交按钮改「已提交」、勾上选中项）再照常派发给 agent，与官方一致。

与官方的差异（有意为之）：

| 项 | 官方 | 本 fork | 原因 |
| --- | --- | --- | --- |
| 日志 | 打印整张卡片 JSON | 只记数量、`card_type`、`task_id` | 卡片正文含用户内容 |
| 发送失败 | 仅记日志 | 正文追加「⚠️ 有 N 张卡片消息发送失败。」 | JSON 此时已从正文移除，静默等于这一轮看着答完了、用户却什么也没收到 |
| 核心字段缺失 | 仅告警仍发送 | 跳过该张并记 `reason=missing-<field>` | 必然被服务端拒绝，发它只是白跑一次 |
| 群聊 | 不带 `chat_type` | 带 `chat_type` | 与本 fork 其它主动推送一致（官方文档：不填按群聊处理） |

`index.ts` 同步注入卡片能力的 system context（此前只有官方有）。

### 1.3 未完成回合不再宣称完成（原 P0-2）

deferred 回合走主动推送时，尾巴文本后面仍会挂 `（回复完毕）`。来源不是 `finalAppendCompletionMarker`，而是 `deliverNormalFinalViaStream` 里的 `fallbackAppendCompletionMarker = !options.isError`——推送没有气泡上下文，正常回合确实需要这个标记来表示答案到此为止，但 deferred 回合的答案还在后面。

修复：编排层把 `channelData.wecomDeferredTurn` 传给 transport，transport 据此同时压掉 fallback 标记与 reasoning-only 的标记提升。正文该推的照推，只是不再宣称完成。

### 1.4 入站附件超限给出可操作提示（原 P1-1）

复现确认用户实际看到的是 `response body too large (>83886080 bytes)`——既不说上限是多少，也不说去哪儿改。

修复：`readResponseBodyAsBuffer` 抛类型化的 `ResponseBodyTooLargeError`（区分「文件太大」与「网络断了」，后者不能被伪装成前者）；`WecomMediaService` 把它翻译成写明上限与去向的中文提示，并在调用核心媒体库之前先自检 buffer 大小——核心库自己的拒绝文案同样不可操作。

### 1.5 skills 与官方的差异已定性并记录（原 P2-1）

与官方的差异共 8 个文件，逐个定性完毕，**均为有意保留**：

- `wecomcli-preflight/SKILL.md`：**必须**保留的适配。本插件 ID 是 `wecom`，官方是 `wecom-openclaw-plugin`，照抄会让预检查放行错误的插件 ID。
- 其余 7 个：只差行尾空白。本 fork 对随包文档做过行尾空白规范化，`git diff --check` 是发布门禁的一环，逐字回同步会让门禁常红。

其中 `smart-sheet-view-types.md` 被去掉的是 Markdown 两空格硬换行——试过逐字回同步，确认它只影响**人类渲染**时的换行；skills 是给模型读原始 Markdown 的，无功能差异，因此维持规范化版本。

**下轮不要再把这 8 个文件当作漏同步。**

### 1.6 `file-type` 依赖差异已核实，无需处理（原 P1-3）

官方用 `file-type` 做魔术字节嗅探，其 `openclaw-compat.ts` 明写这是 SDK 缺 `detectMime` 时的**回退**。本 fork 锁定 OpenClaw `2026.7.1-2`，直接用 SDK 的 `detectMime({buffer, headerMime, filePath})`，能力等价，不引入这条依赖。

---

## 二、明确不做

### 2.1 入站视频首帧提取（原 P1-2）

官方 `src/webhook/video-frame.ts`（37 行，ffmpeg）只在 **webhook** 链路提取第一帧，**官方自己的 Bot WS 主链路没有**。本 fork 主链路是 Bot WS，入站视频已作为附件下载并把路径交给 OpenClaw。

不做的理由：引入 ffmpeg 硬外部依赖，装了才生效、没装静默失效，而收益在我们的主链路上是推测性的。**需要时再单独立项**，不要顺手加。

### 2.2 `package-lock.json` 为 0 字节导致 `npm audit` 不可用（原 P2-3）

`npm audit --omit=dev` 返回 `ENOLOCK`。生成 lockfile 会改变安装解析结果，属于会影响使用者的动作，**需要你点头**，本轮未擅自生成。

---

## 三、仍然开放的验收缺口

**Windows 真机（原 P2-2）。** CLI 子进程 spawn、插件私有 `node_modules` 里 `@wecom/cli-win32-x64` 的 `require.resolve`、`WECOM_CLI_CONFIG_DIR` 的 0700 可写性，均只在 Linux x64 验过。官方**没有 `win32-arm64` 平台包**——目标机若是 ARM，整条 CLI 链路不可用。

**真实企业微信网关与客户端。** 网关模拟器不能替代真机；模板卡片这轮尤其需要真机确认渲染与交互回调。

---

## 四、本轮已逐条核对、确认无差异（下轮不必重做）

- **CLI 层**：`argv.ts` / `const.ts` / `credentials.ts` / `locate.ts` / `process-output.ts` / `tool.ts` 与官方 `2026.8.17` 源码逐函数比对一致。常量全等（45s / 30s / 3s+3s / 64KiB / 5min）；`CLI_RESIGN_CODES` 含 `853000` 而 `auth init` 自身报 `853000` 绝不重试的**不对称**已落地；`stdio: ["ignore","pipe","pipe"]`（非 TTY，cli 才走 `--bot-id/--secret` 直连）正确；禁用集、`--config-dir`/`--home` 拦截、目录 `0700`、`(botId,secret)` 指纹隔离、全局串行、5 分钟熔断全部一致。本 fork 在官方之上多了 secret 脱敏、endpoint 裁剪、`allowAuth`、`via` 标记。
- **Skills**：16 个目录与官方同名同内容，差异仅为上述 1.5 已定性的 8 个文件。
- **媒体阈值**：图片/视频 10MB、语音 2MB、文件 20MB，与官方 `const.ts` 完全一致。
- **多账号 fail-closed**：`resolveWecomAccount` 对未知账号 ID 返回 `createMissingResolvedAccount`，`resolveCliBot` 随即因缺 botId/secret 抛错，不会回退到第一个账号；`default` 合成别名在多账号下被 `2.7.260-20` 挡掉。
- **MCP → CLI 兜底路由**：`msg→message`、`schedule→calendar`、`doc→doc/sheet/smartsheet/smartpage/media` 正确；`mail` 与 CLI 顶层命令同名（`skills/wecomcli-email` 用的就是 `wecom-cli mail`），不需要别名。模型可控的 `category` 走不通 `auth init`（被 `assertSafeArgv` 拦下）。
- **上游同步度**：官方 git HEAD 之后没有我们未同步的功能提交；最后一次功能提交是 2026-08-17。
- **`openclaw-compat.ts`**：官方用于跨 SDK 版本探测导出，我们锁定 `2026.7.1-2`，不需要移植。

---

## 五、边界

- 本文件只列**有证据**的条目。没有复现或没有官方源码支撑的猜测不写进来。
- 第二节两项（视频首帧、lockfile）是明确不做，不是遗漏；要做需要单独立项或你点头。
