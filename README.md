# dsh-tui-antigravity

在 dsh-TUI 中使用本机 Antigravity CLI。宿主提供聊天、审批、问题、设置和会话 UI，`agy acp` 执行工作并保存原生历史。目标是覆盖官方 CLI 的日常工作流。开发基线为 dsh-TUI 0.20.2，已在 WSL 和 agy 1.5.9、1.5.13 上做过真实终端验证。

## 安装和账号

需要能在终端运行 `dsh-tui`、`dsh`、`agy acp --help` 和 Node.js。下面的安装方式会把源码目录链接到当前 dsh-tui profile，后续移动目录时需重新安装。

```sh
cd /home/wqwt/code/dsh-tui-antigravity
npm ci
dsh plugin --profile dsh-tui add "$PWD"
dsh-tui --backend antigravity
```

启动页和 `/kernel` 也可选 Antigravity。可用 `ANTIGRAVITY_EXECUTABLE` 指定 CLI 的绝对路径。退出后用 `dsh plugin --profile dsh-tui remove dsh-tui-antigravity` 卸载。

已有 agy 登录会被复用。首次登录或切换已有 Google 账号时，输入 `/login`，在链接打开的 Google 页面选择账号，将回跳网址或一次性授权码粘贴到 TUI 的掩码输入框。插件把答案经 stdin 交给本机 `agy acp --login`，由 agy 完成授权和存储。Esc 取消操作。首次成功后输入 `/new`，让宿主对正式会话 ID 加锁。切换时先结束当前回合，成功后重新连接，按新连接的原生会话目录确认旧会话可恢复。如果找不到对应会话，使用 `/new`。账号是本机 CLI 共享状态。[官方认证和 ACP 接口](https://antigravity.google/docs/ide/extensions/acp)

## 在 TUI 中使用

| 场景 | 入口及行为 |
| --- | --- |
| 配额与积分 | `/usage`、`/quota` 展示每个模型组实际返回的剩余额度、周期和重置时间，支持刷新和关闭。`/credits` 显示积分或账号未提供数据。数据来自 agy 的 headless 命令结果，要求模型回合数为零。 |
| Antigravity 功能菜单 | `/agy`。当同名命令由 dsh-TUI 接管时，使用 `/agy config`、`/agy permissions`、`/agy hooks`、`/agy skills`、`/agy agents` 等明确选择 Antigravity。报告可刷新、翻页。`/agy account` 显示服务端提供的套餐。 |
| 扩展管理 | `/agy plugins` 安装、启停及卸载原生插件。`/agy mcp` 新建基本 stdio/HTTP 服务、启停及移除，执行前显示命令并确认。宿主 `/mcp` 也能查询原生服务。带自定义密钥或请求头的服务可通过官方 CLI 设置，随后在 TUI 管理。 |
| 模型与执行 | 模型、思考强度和权限模式从当前 ACP 会话读取，变更后以服务端返回值为准。`/plan`、`/plan off` 切换原生模式。`/agy commands` 列出当前会话动态公布的命令；可用 `/agy <命令> [参数]` 调用它们，包括本机观察到的 compact、goal、schedule、browser、swarm 等。具体可用性随账号、版本和配置变化。 |
| 聊天与工具 | 流式文本和思考、图片输入、工具调用和 diff、原生权限审批、ACP 表单问题、取消、排队和回合内引导。`/agy diff` 汇总当前会话已完成的工具结果中有前后文本的编辑。文件操作是否需要审批由 agy 决定。[官方权限规则](https://antigravity.google/docs/permissions) |
| 历史与会话 | `dsh-tui --backend antigravity --resume <id>`、宿主会话浏览器、官方 `agy --conversation <id>` 使用同一份原生历史。恢复前核对目录和身份，避免误开空会话。退出时显示恢复命令。跨前端操作同一会话时，先关闭已有写入端。 |

## 验收证据

- **真实 TUI** 已验证内核选择、真实模型回复、工作区编辑、工作区外编辑的允许和拒绝、拒绝后的继续对话、Esc 中断，以及中断后开启新回合。安装期间和卸载后，Codex 都能完成真实模型回合。
- **配额和登录** 已用 PTY 验证 `/usage` 能显示真实模型组和剩余量，无凭据时 `/login` 能显示官方 Google 链接及掩码问题。真实浏览器授权、跨 Google 账号登录的端到端结果待用户操作。成功和取消的协议分支另有离线测试。
- **原生会话** 实测 TUI → 官方 CLI → TUI 往返、跨前端记忆和恢复后工作目录。已实测切换模型、强度及计划模式、识别图片颜色。agy 1.5.13 在一轮执行期间接受了第二条 prompt 并输出更正内容。真实 ACP 握手、账户模型目录和回合会耗用本机登录及相应额度。
- **管理操作** 在临时 HOME 中通过真实 agy 添加、停用、删除 MCP 服务和本地测试插件。配置错误、临时账号、原生限额会改变各报告实际提供的内容。

在仓库中可复现以下检查。

```sh
npm ci
npm test
node test/live-management.mjs
node test/live.mjs
```

前两项准备依赖并进行无凭据的协议回归。管理检查使用本机 agy 和临时 HOME。最后一项需要已登录账号，消费两个真实模型回合，在临时工作区核对目录范围、原生 CLI 续聊和历史回放。原生测试会话由 agy 保存。

## 与官方 CLI 的差距

| 功能 | 当前边界及原因 |
| --- | --- |
| 原生会话改名、分叉、删除、归档、回滚 | 1.5.13 对 session/set_info、fork、delete、archive、rewind 的 ACP 探测均返回 -32601。官方交互 CLI 有 /fork、/rename 和 /resume 浏览器的 F2 Rename、F4 Delete。保留原生语义，暂从官方 CLI 办理。Codex 的归档和 agy 的删除有不同的数据保留语义。[原生会话管理](https://antigravity.google/docs/cli/conversations/) |
| 第三方模型 | 当前客户端只展示 agy 向它公布的模型。官方明确限定哪些 ACP 编辑器可用第三方模型。[官方客户端与模型范围](https://antigravity.google/docs/ide/extensions/acp) |
| 终端专属交互 | 语音、远程控制、CLI 状态栏、终端标题、原生任务监视器和完整子代理管理器等依赖原生终端、后台服务或特定 UI。在会话中可调用 agy 上报的相应命令，独立管理面板、实时子任务控制及完整可视化仍有差距。 |
| 配置编辑与集成 | 模型、强度、执行模式、插件和基本 MCP 已有操作入口。完整配置编辑、hook 作者工具、复杂 MCP 环境变量和凭据录入仍用原生入口。插件不维护第二套账户、配额、任务或历史数据库。 |
| 仍待验证 | 授权失效后的真实恢复、两端并发写保护、历史图片回放、跨平台、多账号端到端及大规模历史。动态出现的 ACP 命令只表示原生可调用，具体的调度、浏览器、工作流和团队任务尚未全部逐项实测。 |

对标参考为 [dsh-TUI v0.20.2 的 Codex 后端](https://github.com/ccch1mneyyy/dsh-TUI/blob/v0.20.2/docs/codex-backend.md)、[宿主后端插件契约](https://github.com/ccch1mneyyy/dsh-TUI/tree/v0.20.2/scripts/fixtures/third-party-backend) 和 [Antigravity 官方配额面板](https://antigravity.google/docs/cli/commands/usage)。
