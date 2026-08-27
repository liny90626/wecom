# `wecom-cli` P0 可行性判定

日期：2026-08-27

## 结论

Linux x64 的插件运行链路已通过：OpenClaw `2026.7.1-2` 可以由插件封装 spawn `@wecom/cli@1.2.0`，平台包可解析，账号隔离目录可写且权限为 0700。CLI 接入具备继续落地条件。

Windows x64 的平台包由 npm 元数据确认存在；Windows ARM64 没有官方平台包。真实 Windows Gateway、企业微信网关和客户端仍需在目标机器做一次验收，不能用本机 Linux 结果替代。

## 本机证据

```text
npm ls openclaw @wecom/cli --all
@yanhaidao/wecom@2.7.260-19
├── @wecom/cli@1.2.0
└── openclaw@2026.7.1-2

插件封装 spawn 输出：
source=@wecom/cli-linux-x64
status=0
timedOut=false
stdout=wecom-cli 1.2.0 (wecom 2026-08-25T10:18:35Z 78c514b)
```

新增模拟进程用例还验证了：`WECOM_CLI_CONFIG_DIR` 写入 state 目录、目录隔离、凭据短路、并发去重、全局授权串行、强制重签冷却、输出上限和超时收口。候选 tgz 另做了 `npm install --omit=dev` 隔离安装，确认 `@wecom/cli-linux-x64` 可解析且 `wecom-cli 1.2.0` 可执行。

## 目标机待验

- Windows x64：从本插件安装包执行 `npm install --omit=dev` 后，确认 `require.resolve("@wecom/cli-win32-x64/package.json")` 与 `bin/wecom-cli.exe` 均可用。
- Windows x64：使用真实配置启动一次 Gateway，确认非交互 `auth init --bot-id/--secret` 不进入扫码分支，且 state 目录可写。
- 对照 CLI 与已配置 MCP(apikey) 返回的 `extra_identity_context`，确认授权真人用户是同一身份。
- 完成一次只读 CLI 命令和一次 `851003` MCP 兜底演练；记录日志中的 `via=cli-fallback:<reason>`，不以写操作做冒烟。
