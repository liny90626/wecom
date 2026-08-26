# goal.md — `wecom-cli` 接入专项（候选 `2.7.260-17`）

> 状态：**待审查**。本文件只做目标定义，未改动任何生产代码。
> 上一轮（上游核查 + `wecom_mcp` 收口）已全部结束，收口记录见 §0。

---

## 0. 上一轮收口（已完成，不再展开）

| 版本 | 内容 | 状态 |
| --- | --- | --- |
| `2.7.260-12` | 断连事件不再当成用户消息跑 agent；`undici` 7.29.0 清 high；主动推送带 `chat_type` | **已发布** |
| `2.7.260-13` | `wecom_mcp` 从零补到 28 条用例；`biz_type` 归一（后被 `-14` 撤回） | **已发布** |
| `2.7.260-14` | 严格对齐官方 MCP 实现：身份 header、官方 UA、官方错误码分工、文档授权引导卡片 | **已发布** |
| `2.7.260-15/16` | 身份改取 `ctx.requesterSenderId`；`tools/list` 限幅按实测体积回归；`bot.mcpServers` 配置；官方插件同步（事件白名单、`enter_check_update` 版本握手、`auth_change_event` 清缓存） | **已构建，未打 tag**（等 apikey 方式真机验证通过后发布） |

细节见对应 `changelog/v2.7.260-*.md` 与 `SESSION_HANDOFF.md` 第 2q–2u 节。

---

## 1. 为什么要做这个专项：`851003` 的结构性结论

现网实测（2026-08-26）证明，两条签发路径指向的是**两个不同的产品**：

| 来源 | 端点 | `serverInfo` | 身份 |
| --- | --- | --- | --- |
| `aibot_get_mcp_config`（机器人长连接） | `/mcp/robot-doc` | **「企微机器人文档 MCP」** | 只有机器人自己 |
| 后台「查看使用方式」的 apikey | `/mcp/v2/bot/doc` | **「动态文档 MCP」** | **内嵌授权真人用户** |

服务端 `help_message` 与之完全吻合：「机器人不允许编辑由成员或其他机器人创建的文档」。**这不是授权没生效，是产品定位不同**——`aibot_get_mcp_config` 这条路**结构性地拿不到成员作用域**，把 `plugin_version` 从魔法串改成真实版本号后端点毫无变化，该假设已证伪。

于是 MCP 只剩「人工配 8 条 apikey」一条路：配置复杂、每个能力单独授权、不易维护。

## 2. CLI 路线：已实测可行

用真实 `botId` + `secret` 验证（2026-08-26，`@wecom/cli@1.2.0`）：

| 验证项 | 结果 |
| --- | --- |
| `wecom-cli auth init --bot-id <ID> --secret <SECRET>` 非交互 | **成功**，只需插件配置里已有的凭据，**无需任何 apikey** |
| 成员作用域 | **有**——返回里带 `extra_identity_context`：「机器人身份 … / **授权真人用户身份：…**」，与后台 apikey 完全一致 |
| 真实数据 | `doc search --keywords 会议记录` 返回真实文档（标题、docid、highlight、url） |
| 服务面 | **15 个**（calendar / chat / contact / disk / doc / mail / media / message / meeting / sheet / smartpage / smartsheet / todo / auth / help），多于 MCP 的 8 个品类 |
| Schema 自描述 | CLI 自带 discovery 缓存（`~/cfgdir/cache/service_doc.json` 43KB 全量 JSON Schema），且每级命令都有 `--help` |
| 许可 | 官方插件 **MIT**，可借鉴实现 |

**代价（同样是量出来的）**：官方 `src/cli` **1643 行**；平台二进制 `@wecom/cli-linux-x64` 解包 **11.4MB**；本插件目前**零子进程**。

---

## 3. 本专项的方针（用户已明确）

1. **严格参考官方实现**——不自创协议、不复刻凭据算法。官方源码原话：签名算法、AES-GCM 格式、`.encryption_key`、原子写「曾是整套方案最脆的部分」，现已整体委托给 CLI，插件只保留 openclaw 侧策略。
2. **完成后 CLI 为默认**，`wecom_mcp` **降级为兜底**（配了 `bot.mcpServers` 仍可用）。
3. **不拆 MCP**——两条平面共存，保留回退余地。

---

## 4. 分阶段目标与验收

### P0（前置卡点）子进程与二进制可用性 —— **不通则整条路作废**

| 项 | 目标值 |
| --- | --- |
| OpenClaw 运行环境能 spawn 子进程 | 实测通过（含沙箱会话） |
| `@wecom/cli` 平台二进制可落盘并执行 | Windows / Linux 至少各验一次（现网是 Windows） |
| `WECOM_CLI_CONFIG_DIR` 可写 | 目录落在 `resolveStateDir()` 下，权限 600 |
| 结论 | **一页纸的可行性判定**，不通就停在这里并说明原因 |

> 这一步必须先做：本插件至今零子进程，沙箱策略未知；后面三阶段全部依赖它。

### P1 凭据层（严格照搬官方 `src/cli/credentials.ts` 的四件事）

| 项 | 目标值 |
| --- | --- |
| 授权动作 | 只 spawn `wecom-cli auth init --bot-id --secret`，**不自实现任何凭据协议** |
| 目录隔离 | 每个 `(botId, secret)` 组合一个目录（secret 轮换即时生效、多 bot 互不干扰） |
| 短路 | `auth init` 非幂等，已有可用登录态时不得重复调用（官方注明会撞 `45009` 限频） |
| 并发去重 + 全局串行 | 同一 bot 的并发授权合并为一次 |
| 重签冷却熔断 | 失败后有冷却，不得无限重签 |
| 用例 | ≥ 8 条（四件事各 ≥ 2 条，含"已有登录态不再 spawn"的敏感性验证） |
| 凭据纪律 | `secret` / `credentials.enc` 内容**一律不进日志**；日志只出目录指纹 |

### P2 注册 `wecom-cli` 工具

| 项 | 目标值 |
| --- | --- |
| 工具名 | `wecom-cli`（与官方一致，便于用户既有白名单/技能复用） |
| 运行环境 | 由插件按当前会话的机器人注入 `WECOM_CLI_CONFIG_DIR`；**禁止**调用方传 `WECOM_CLI_*` 或 `--config-dir` |
| 输出 | 有界收集（官方 `BoundedOutputCollector`），超限截断并说明 |
| 错误 | 解析 `errcode`；`45009`/授权类给可执行提示，不降级到 `exec` |
| 上下文体积 | 沿用 MCP 的教训：**先量再定阈值**，不凭估算 |
| 用例 | ≥ 10 条（含超限截断、errcode 解析、环境注入不可被覆盖） |

### P3 默认切换 + MCP 兜底

| 项 | 目标值 |
| --- | --- |
| 默认 | CLI 可用时，`wecom-cli` 为默认能力入口 |
| 兜底 | `wecom_mcp` 保留；配了 `bot.mcpServers` 时仍完全可用 |
| 选择逻辑 | 可预测且可诊断：日志明确打出本次走的是哪条平面及原因 |
| 回归 | 现有 MCP 的 31 条用例**全绿不变** |

### P4 文档与红线

- `README.md`：CLI 为主路径的配置与排障（**不含任何真实凭据**）；`bot.mcpServers` 降级为兜底说明。
- `changelog/v2.7.260-17.md` + `changelog/README.md` + 版本号。
- `SESSION_HANDOFF.md`：新增事件档案与禁改条目（至少：**不得自实现凭据协议**、**`auth init` 必须短路**、**环境变量只能由插件注入**）。

### 全局验收

`48 文件 / 652 用例` → **不减**，新增用例全绿；`npx tsc --noEmit`、`npm run build`、`npm run verify-dist`、B1/B2/B3、`git diff --check` 全过；只用与生产一致的 OpenClaw **2026.7.1-2**。

---

## 5. 明确不做（及理由）

| 不做 | 理由 |
| --- | --- |
| **移植官方 16 个技能包（1.3MB）** | CLI 每级命令都有 `--help`、discovery 缓存自带全量 JSON Schema，模型可自描述发现。先不带，实测发现模型确实用不明白再补 |
| **拆掉 `wecom_mcp`** | 用户明确要求保留为兜底；且 MCP + 后台 apikey today 就能用，是 CLI 不通时的退路 |
| **自实现凭据协议** | 官方源码明写这是「整套方案最脆的部分」，改一处格式插件就静默解密失败且表现为"未授权" |
| **手动执行 `wecom-cli auth init`** | 官方明确禁止：会绕过 openclaw 配置。凭据由插件统一管理 |
| **继续追 `aibot_get_mcp_config` 拿成员作用域** | 已证伪：那是「企微机器人文档 MCP」，产品定位不同，不是配置问题 |
| **移植官方 4 个 MCP 拦截器** | `msg-media` / `smartpage-create` / `smartpage-export` / `smartsheet-upload`，涉及本地文件与沙箱边界；若 CLI 成为默认，它们的价值大幅下降，留待 CLI 落地后再评估 |

---

## 6. 风险

| 风险 | 评估 | 处置 |
| --- | --- | --- |
| 沙箱不允许 spawn | **整条路的前置卡点** | P0 先验，不通即停并如实报告 |
| 平台二进制体积/分发 | 11.4MB/平台，用户需 `npm i -g @wecom/cli` 或由插件依赖引入 | P0 一并确认安装方式与体积可接受度 |
| `auth init` 限频 `45009` | 非幂等，重复调用会被限 | 短路 + 冷却熔断，照搬官方策略 |
| CLI 版本漂移 | CLI 与插件各自发版，命令面可能变 | 依赖 `--help`/discovery 而非硬编码命令；记录实测版本 |
| 两条平面行为不一致 | 用户可能困惑走了哪条 | 日志明确打出所选平面与原因；文档写清 |
| Windows 路径/权限 | 现网是 Windows | P0 必须在 Windows 上验一次 |

---

## 7. 执行顺序（批准后）

1. **P0 可行性**：出一页纸判定 —— 不通就停。
2. P1 凭据层 → 用例 → 敏感性验证。
3. P2 工具注册 → 用例 → 上下文体积实测定阈值。
4. P3 默认切换 + MCP 兜底 → 现有 31 条 MCP 用例全绿。
5. 多维走查 / 代码审核 / 模拟测试 → 修完再汇报。
6. 你同意后才：更新文档 → 打 tag → 推 **fork**（`origin` 只读，绝不推）→ 最后打包。

---

## 8. 待办（与本专项并行，不阻塞）

- `2.7.260-16` 等你用 apikey 方式验证通过后打 tag 推远端（当前本地 `d81e889`，`fork/main` 停在 `b0f67b2`）。
- 上游 `YanHaidao/wecom` 的新提交仍未合并。
- 官方 MCP 的 4 个拦截器未移植（见 §5）。
