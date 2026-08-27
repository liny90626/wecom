# goal.md — `wecom-cli` 接入专项（候选 `2.7.260-18`）

> 状态：**实现、自测、打包与 fork 推送已完成**。`2.7.260-18` 的 CLI 接入、窄范围 MCP 兜底、官方 Skills 与文档已落地；Linux x64 自测已通过，Windows 真机/企业网关验证仍是后续环境门禁。
> 上一轮（`wecom_mcp` 收口）已随 `2.7.260-17` 发布，细节见 `changelog/v2.7.260-17.md`，此处不再展开。

---

## 1. 立项依据（两句话）

`851003` 的根因是**结构性**的：`aibot_get_mcp_config` 签发的 `/mcp/robot-doc` 是「企微机器人文档 MCP」，**只有机器人自身作用域**；后台 apikey 签发的 `/mcp/v2/bot/<biz>` 是「动态文档 MCP」，内嵌授权真人用户。于是 MCP 只剩「人工配 8 条 apikey」一条路。

而 CLI 只要**插件配置里已有的** `botId` + `secret` 就能拿到成员作用域（2026-08-26 用真实凭据实测，`@wecom/cli@1.2.0`），**无需任何 apikey**，且服务面 15 个 > MCP 的 8 个品类。

## 2. 官方实现已完整获取——本专项是「照搬 + 适配」，不是「设计」

`@wecom/wecom-openclaw-plugin@2026.8.17` 的 `dist/src/cli/`，**9 个文件 1232 行，注释含大量「为什么」**：

| 文件 | 行 | 职责 |
| --- | --- | --- |
| `tool.js` | 363 | tool 包装、按 botId 串行、重签重试、错误整理 |
| `credentials.js` | 342 | 目录隔离 / 短路 / 并发去重 / 全局串行 / 冷却熔断 |
| `locate.js` | 196 | 二进制寻址（拒绝 PATH 上的全局 cli） |
| `argv.js` | 155 | 引号感知的词法切分 + 安全校验 |
| `const.js` | 107 | 超时、上限、禁用集、错误码 |
| `process-output.js` | 43 | `BoundedOutputCollector` |
| `legacy-tool-warning.js` / `index.js` / `process-launcher.js` | 26 | 其中 `process-launcher.js` 只有一行：`export { spawn } from "node:child_process"` |

同版本的 `dist/src/mcp/` **已整体删除**——官方在自己的插件里已完成 MCP → CLI 的迁移。

### 2.1 官方定死的常量（照抄，不自己拍）

`CLI_TIMEOUT_MS=45s`（业务命令，实测热缓存 300~500ms）· `CLI_AUTH_TIMEOUT_MS=30s` · `KILL_GRACE=3s` + `FORCE_WAIT=3s` · `MAX_OUTPUT=64KB` · `RESIGN_COOLDOWN=5min`
`CLI_RESIGN_CODES = {893999 无凭据, 853004 token 过期, 853005 token 无效, 853000 secret 失效}`；**`45009` 限频不在其中**。
禁用：顶层 `init`；`auth {init,login,logout,bind,unbind}`。
配置目录：`<state>/wecom-cli/<safeBotId>-<sha8("botId:secret")>`，`mode 0700`。

### 2.2 只有读源码才知道的六件事（漏一件就是一轮无效调试）

1. **cli 只在 stderr 非 TTY 时才走 `--bot-id/--secret` 直连分支**，否则**静默忽略参数**回退扫码 → 挂到超时。`stdio` 用 `["ignore","pipe","pipe"]`，stdin 用 `ignore` 而非 `pipe`（万一走到交互分支，让它立刻拿 EOF 而不是挂着等输入）。
2. **`auth init` 刻意不复用业务命令的 `runCli`**——后者会把 `argv.join(" ")` 打进日志，secret 会被写进 openclaw 日志文件并持久化，比 `ps` 可见严重得多。
3. **`853000` 的不对称**：业务命令报它 = 磁盘凭据里的 secret 已失效而配置里可能已是新的 → 重签一次自愈；**`auth init` 自身报它 = 配置里的 secret 就是错的 → 绝不重试**，否则只是离 `45009` 更近。
4. **绝不使用 PATH 上的全局 `wecom-cli`**：它绑定用户自己的 bot（默认 `~/.config/wecom`），误用会「拿 A 企业的凭据查 B 企业的数据」，是**静默的数据越权**。只接受插件依赖内的二进制或配置显式指定的路径。
5. **多账号时不回退默认账号**：`resolveBot` 刻意不继承 `resolveCurrentAccountId()` 的回退行为——上下文丢失时回退等于串号，**宁可失败**。
6. **shell 元字符检查是引号感知的**，且刻意**不含** `{}` `()` `$`——`{}` 是 `--json` 的必备字符、`()` 出现在成员名里（`张三(jackzhang22)`）、`$` 出现在金额里。误杀合法参数的代价远大于放过一个怪参数。

### 2.3 分发方式：已确定，且我上一轮的建议是错的

官方把 `@wecom/cli` 写进 **`dependencies`**（不是 peer、不是让用户全局装），运行时用 `require.resolve` 在**插件私有 node_modules** 里找平台子包，另留一个配置逃生舱 `channels.wecom.cli.binPath`。

> **更正**：我上一轮建议「用户全局 `npm i -g @wecom/cli`，插件检测并给指引」。这条**错误且危险**——正是官方 `locate.js` 头部注释明确拒绝的做法，理由见 §2.2 第 4 条。已撤回。

已核实可行：
- OpenClaw 装插件时会跑 **`npm install --omit=dev`**，且**专门有平台相关依赖的验证与修复逻辑**（`install-YXjfuIuN.js:1094/1139`）。
- 平台子包齐全：`win32-x64`（9.98MB）· `linux-x64`（11.4MB）· `linux-arm64` · `darwin-x64` · `darwin-arm64`。**无 `win32-arm64`**。
- 因此**我们的 tgz 仍是 ~249KB**，10MB 二进制由 npm 在安装时按平台拉取。

### 2.4 skills：带上（**这推翻了上一版 §5 的判断**）

官方 16 个 skills（1.3MB）随包发布，`openclaw.plugin.json` 用 `"skills": ["./skills"]` 挂载；**OpenClaw 2026.7.1-2 就认这个字段**（`manifest-D7Lv7P8W.js:857`）。

改判的理由是看了实际内容：skills 里有 `--help` **给不出**的东西——**能力之间的路由规则**。例如 `wecomcli-doc` 的 description 明写「泛化的『创建文档 / 整理成文档』默认必须路由到 `wecomcli-smartpage`，本技能不得抢占」「出现字段/筛选/排序/分组语义时，严禁用 doc + markdown 静态表格变通替代」。这类知识模型无法从命令帮助里推导，猜错的后果是**建错文档类型**。另有 `wecomcli-preflight` 负责工具白名单前置检查。

## 3. 路由策略（2026-08-26 你已明确）

- **新功能走 CLI**——CLI 独有的能力一律只在 CLI 侧接入，不回头补 MCP。
- **旧功能依旧 MCP**——现网已验证通过的路径**一行不动**，31 条用例保持全绿。
- **MCP 异常时用 CLI 兜底**——但兜底范围要分类，见 §3.1。

### 3.1 兜底范围

| MCP 异常 | 兜？ | 理由 |
| --- | --- | --- |
| 配置层：没配 `bot.mcpServers` / `is_authed=false` | ✅ | 零副作用，且正好覆盖 `851003` 那整条问题链 |
| **`851003 no authority`** | ✅ | 服务端已明确拒绝（⇒ 确定没执行），CLI 有成员作用域能真救回来。**兜底价值最高的一类** |
| `851013/851014/851008` 文档未授权 | ❌ | CLI 同样拿不到，只是换个说法多花一次往返，还会盖掉授权引导卡片 |
| `45009` 限频 | ❌ | CLI 的 `auth init` 撞的是同一个 `45009`，雪上加霜 |
| 传输层：超时 / 5xx / 连接重置 | ⚠️ 只兜读 | 见 §3.2-1 |

### 3.2 三条真实风险（实现前必须处置）

1. **写操作重复执行**——超时或 5xx **不代表服务端没执行**，兜底重跑会让 `msg` 发消息、`doc` 追加、建日程这些**非幂等**操作出两条。红线：**只有拿到 `errcode` 的业务错误才自动兜底**（服务端明确拒绝 ⇒ 确定未执行）；传输层异常不自动兜写操作，把两条平面的结论一起交给模型。这个判据比维护幂等方法白名单可判定得多，也不会随企微加方法而腐坏。
2. **诊断被静默掩盖**——兜成功后用户只看到「成功」，MCP 挂了几周没人知道。返回体必须带 `via`（走了哪条平面、因为什么码兜的），日志必打。
3. **延迟叠加**——最坏 = MCP 超时预算 + CLI 冷启动。企微机器人有回复时限。兜底路径给**独立且更短**的预算；CLI 授权在**插件启动时预热**，绝不落在兜底路径上。

### 3.3 身份语义：需要核实，但风险比看上去小

官方 `2026.8.17` 里 **`ctx.requesterSenderId` 与 `x-openclaw-wecom-userid` 已完全消失**（全库零命中）——CLI 路线**没有 per-request 身份**，身份固定为「授权真人用户」。

但这不必然是问题：MCP 走 `bot.mcpServers` 时，**有效身份也是 apikey 内嵌的那个「授权真人用户」**，那个身份头的服务端实际效果我们从未证实过（它没能改变 `851003` 的任何行为）。官方把它整个删掉，反过来佐证它不重要。

**所以这是一个核实项而不是待决策项**：P0 里对照两条路返回的 `extra_identity_context`，确认「授权真人用户」是同一个人。是 → 兜底不改变身份，风险归零；否 → 兜底只在单人会话生效，并在 §3.1 里降级。

### 3.4 成本认知：本策略比「CLI 为默认」**更贵**

「CLI 为默认」只需一个开关加一处路由；本策略额外要：能力归属表、异常分类器、「是否确定未执行」判据，以及**两条平面的返回格式归一**（MCP 回 JSON-RPC `content`，CLI 回 stdout JSON，同一能力两次调用长得不同会让模型困惑）——最后这条是我此前低估的。

**因此分两步落地**：第 1 步只兜「配置层 + `851003`」；第 2 步等现网跑一段，**依据日志里实际出现过哪些码**再决定是否扩大。同 `48KB` 阈值那条教训：**先量再定**。

---

## 4. 分阶段目标与验收

### P0（前置卡点）—— **不通则整条路作废**

| 项 | 目标值 |
| --- | --- |
| OpenClaw 能 spawn 子进程 | 实测通过。官方 `process-launcher.js` 就是裸 `node:child_process` 无任何沙箱适配 → 风险低，但**必须在现网 Windows + OpenClaw 2026.7.1-2 上验**（官方目标是更新的 openclaw） |
| 平台子包落地 | `npm install --omit=dev` 后 `require.resolve("@wecom/cli-win32-x64/package.json")` 在插件私有 node_modules 里可解析，且 `bin/wecom-cli.exe` 可执行 |
| `WECOM_CLI_CONFIG_DIR` 可写 | 目录落在我们 `context-store.ts` 的 state 目录下，`mode 0700` |
| **身份核实**（§3.3） | 对照 CLI 与 MCP(apikey) 两条路的 `extra_identity_context`，判定是否同一个「授权真人用户」 |
| 结论 | **一页纸判定**，不通就停在这里并说明原因 |

> 本插件至今**零子进程**，这一步必须先做；后面全部依赖它。

### P1 凭据层（照搬官方 `credentials.js` 的四件事）

| 项 | 目标值 |
| --- | --- |
| 授权动作 | 只 spawn `wecom-cli auth init --bot-id --secret`，**不自实现任何凭据协议** |
| 目录隔离 | `<state>/wecom-cli/<safeBotId>-<sha8("botId:secret")>`，`mode 0700`；secret 一变目录就变 → **改配置立即生效**且不碰熔断 |
| 短路 | 两个文件（`credentials.enc` + `.encryption_key`）都在才算已授权；`.encryption_key` 缺失时 cli 会回退 keyring，而 keyring 可能被锁 → 静默表现为「未授权」 |
| 并发去重 + 全局串行 | 同目录并发合并为一次；`auth init` **跨 bot 也串**（keyring 是全局资源） |
| 重签冷却熔断 | 5 分钟，且**冷却时间在任务真正开始时记录**，不把排队时间算作重签尝试 |
| 清理旧目录 | 只在**授权成功之后**做（反过来会把「可降级」变成「直接不可用」）；双重约束防误删 |
| 凭据纪律 | `secret` 一律不进日志（§2.2-2）；日志只出 `botId` 前 10 字符与目录 basename |
| 用例 | ≥ 8 条（四件事各 ≥ 2，含「已有登录态不再 spawn」的敏感性验证） |

### P2 注册 `wecom-cli` 工具

| 项 | 目标值 |
| --- | --- |
| 工具名 | `wecom-cli`（与官方一致，且必须与 `openclaw.plugin.json` 的 `contracts.tools` 完全一致） |
| 入参 | `args: string[]` = `wecom-cli ` 之后的全部内容；容错去掉模型可能带上的 `wecom-cli` 前缀 |
| 安全校验 | 引号感知词法切分；禁用集（§2.1）；拒绝 `WECOM_CLI_*=` 与 `--config-dir/--home`；**刻意不做品类白名单**（品类由服务端 discovery 动态下发，白名单会在 cli 加品类时过期） |
| 运行环境 | 由插件按当前会话机器人注入 `WECOM_CLI_CONFIG_DIR`；`cwd` 固定到 state 目录（cli 会读 cwd 下的 `.env`）；env 透传仅限官方三项白名单，**模型提供的 env 一律拒绝** |
| 串行 | 同 botId 串行（cli 的 refresh_lock 只是进程内锁，`credentials.enc` 无跨进程文件锁） |
| 重签重试 | 命中 `CLI_RESIGN_CODES` → 强制重签一次后重试，受 5 分钟熔断约束 |
| 输出 | `BoundedOutputCollector` 64KB，超限截断并给出「缩小查询范围」的可操作提示 |
| 错误 | `exit 2` = 参数/子命令错误（提示 skills 与 cli 版本不匹配）；`ENOENT`/`EACCES` 单独文案；改写 cli 里「去跑 `wecom auth init`」的提示（会绕过 openclaw 配置） |
| 用例 | ≥ 12 条（禁用集、引号感知切分、env 不可被覆盖、超限截断、errcode 解析、重签重试与熔断） |

### P3 skills 与路由

| 项 | 目标值 |
| --- | --- |
| skills | 随包发布 `./skills`，`openclaw.plugin.json` 加 `"skills": ["./skills"]`；版本与所依赖的 `@wecom/cli` 对齐并在 changelog 记录实测版本 |
| 新能力 | CLI 独有服务面只在 `wecom-cli` 侧暴露，**不回头补 MCP** |
| 旧能力 | 现网已跑通的 MCP 路径**一行不动**，31 条用例全绿不变 |
| 兜底范围 | 只兜「配置层缺失/未授权」与 `851003`；`851013/851014/851008`、`45009` 明确不兜（§3.1） |
| 未执行判据 | 只有拿到 `errcode` 的业务错误才自动兜；传输层异常**不自动兜写操作**（§3.2-1） |
| 可诊断 | 返回体带 `via`，日志必打（§3.2-2） |
| 延迟 | 兜底路径独立预算；CLI 授权**启动时预热**（§3.2-3） |
| 返回归一 | 同一能力经两条平面返回的形状一致（§3.4） |
| 用例 | ≥ 12 条（该兜的兜到 / 不该兜的不兜各 ≥ 2、写操作超时不自动兜、`via` 标注、预热短路） |

### P4 文档与红线

- `README.md`：CLI 的配置与排障（**不含任何真实凭据**）；写清哪些能力走哪条平面、兜底何时触发、怎么从日志的 `via` 看出本次走了哪条。
- `changelog/v2.7.260-18.md` + `changelog/README.md` + 版本号（`src/version.ts` 由 `version.test.ts` 与 `package.json` 对账）。
- `SESSION_HANDOFF.md` 新增禁改条目，至少：**不得自实现凭据协议**、**`auth init` 必须短路**、**环境变量只能由插件注入**、**绝不使用 PATH 上的全局 `wecom-cli`**、**多账号缺上下文时宁可失败不回退默认账号**。

### 全局验收

`56 文件 / 706 用例` 全绿（相对基线不减，新增用例全绿）；`npx tsc --noEmit`、`npm run build`、`npm run verify-dist`、B1/B2/B3、`git diff --check` 全过；只用与生产一致的 OpenClaw **2026.7.1-2**。Linux x64 从候选 tgz 做了 `npm install --omit=dev` 隔离安装并确认平台 CLI 可执行；Windows x64/ARM64 与真实企业网关仍未验证。

---

## 5. 明确不做（及理由）

| 不做 | 理由 |
| --- | --- |
| **自实现凭据协议** | 官方源码明写这是「整套方案最脆的部分」：签名算法、AES-GCM 格式、`.encryption_key`、原子写——cli 改一处格式插件就静默解密失败，且表现为「未授权」，完全不指向真实原因 |
| **用 PATH 上的全局 `wecom-cli`** | 静默数据越权（§2.2-4） |
| **让 agent 用 `exec` 直接跑 cli** | exec 无法可靠注入 per-bot 的 `WECOM_CLI_CONFIG_DIR`，漏一次就串企业；且企微会话常见的 `messaging` profile 里根本没有 exec |
| **拆掉 `wecom_mcp`** | 旧功能继续走 MCP，现网已验证通过 |
| **无条件兜底** | 写操作在传输层异常时可能已执行，重跑会出两条；且部分错误码 CLI 同样解决不了（§3.1 / §3.2） |
| **品类白名单** | 品类由服务端 discovery 动态下发，白名单会在 cli 加品类时过期，违背「cli 加品类、插件零改动」 |
| **移植官方 4 个 MCP 拦截器** | `msg-media` / `smartpage-create` / `smartpage-export` / `smartsheet-upload`，涉及本地文件与沙箱边界；CLI 落地后价值大幅下降，留待之后评估 |

---

## 6. 风险

| 风险 | 评估 | 处置 |
| --- | --- | --- |
| 沙箱不允许 spawn | **前置卡点**，但官方就是裸 `child_process` → 风险已降低 | P0 在现网 Windows 上验，不通即停并如实报告 |
| 平台二进制分发 | OpenClaw 会跑 `npm install --omit=dev` 且有平台依赖修复逻辑 → 已基本排除 | P0 实测 `require.resolve` 能否解析到 |
| **无 `win32-arm64` 子包** | 现网若是 ARM 版 Windows 则整条路不可用 | P0 顺带确认现网 CPU 架构 |
| `auth init` 限频 `45009` | 非幂等，重复调用会被限 | 短路 + 5 分钟冷却熔断，照搬官方 |
| CLI / skills 版本漂移 | 两者各自发版，命令面可能变；`exit 2` 就是这个信号 | 锁定 `@wecom/cli` 版本、skills 与之同步、changelog 记录实测版本 |
| **兜底重复执行写操作** | **本策略最大的风险**，`msg`/`doc append`/建日程都非幂等 | 只兜「确定未执行」的业务错误码 |
| **兜底把 MCP 故障静默掩盖** | 兜成功了没人知道 MCP 已经挂了 | `via` 必须出现在返回体与日志里 |
| 两条平面身份不一致 | 见 §3.3，很可能是同一个「授权真人」 | P0 对照 `extra_identity_context` 核实 |
| Windows 路径/权限 | 现网是 Windows | P0 必须在 Windows 上验一次 |

---

## 7. 执行顺序（批准后）

1. **P0 可行性**：出一页纸判定 —— 不通就停。
2. P1 凭据层 → 用例 → 敏感性验证。
3. P2 工具注册 → 用例。
4. P3 skills + 路由第 1 步 → 现有 31 条 MCP 用例全绿。
5. 多维走查 / 代码审核 / 模拟测试 → 修完再汇报。
6. 你同意后才：更新文档 → 打 tag → 推 **fork**（`origin` 只读，绝不推）→ 最后打包。

---

## 8. 待办（与本专项并行，不阻塞）

- 上游 `YanHaidao/wecom` 的新提交仍未合并。
- 官方 MCP 的 4 个拦截器未移植（见 §5）。
