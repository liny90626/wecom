# Third-party notices

本仓库的部分代码移植自腾讯企业微信团队的
[`WecomTeam/wecom-openclaw-plugin`](https://github.com/WecomTeam/wecom-openclaw-plugin)，
对账基线为 commit `3b1cbe3e664352821758d99ae5907f5620fce26e`（npm 包 `2026.8.17`）。
该项目的 package 元数据与 README 声明采用 MIT License；记录基线时其仓库内没有单独的 `LICENSE` 文件。

移植并按本插件运行时改写的部分包括：`wecom-cli` 工具与随包发布的 16 个 Skills、模板卡片解析与
就地更新、MCP 身份头 / 错误码分工 / 授权引导卡片、事件白名单与 `enter_check_update` 版本握手、
以及媒体大小阈值。Bot WS 车道（`src/transport/bot-ws`、`src/runtime`、`src/capability/bot`）为本 fork
自行实现，不属于移植范围。

上游 `YanHaidao/wecom` 的原创与增强部分按其 ISC License 发布，见 `LICENSE`。

## MIT License text

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
