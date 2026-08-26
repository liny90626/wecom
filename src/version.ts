/**
 * 插件版本号。
 *
 * 企微 MCP Server 认 User-Agent（官方插件的形态是
 * `OpenClawPlugin/<version> <platform>/<arch>`），所以这个值必须跟着发版走。
 * `version.test.ts` 会拿它和 `package.json` 对账——忘了改会直接变红。
 */
export const PLUGIN_VERSION = "2.7.260-14";
