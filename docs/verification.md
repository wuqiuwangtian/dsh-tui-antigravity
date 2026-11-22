# 开发基线与验收记录

## 原生命令排查（WSL，agy 1.5.14，dsh-tui 0.20.2）

按当前账号的 ACP 命令目录、插件命令表及官方 CLI 参考核对入口。表中的“路由验证”指核对传给 ACP 的命令和正文；启动多个子代理、调用浏览器等运行效果沿用下方已有验收。工作区技能、账号权限及 agy 版本都会改变目录。[官方 CLI 命令索引](https://antigravity.google/docs/cli/reference/)

| 范围 | 检查方式与结果 |
|---|---|
| 当前 ACP 公布的完整目录 | 本次共 11 个：`agy-customizations`、`antigravity-guide`、`browser`、`compact`、`goal`、`grill-me`、`learn`、`plan`、`run-workflow`、`schedule`、`swarm`。用协议替身逐个验证 `/agy <命令> task` 完整到达 `session/prompt`，另测动态工作区技能和未公布命令。|
| 官方只读查询 | `usage`（含 `quota`）、`credits`、`agents`、`hooks`、`skills`、`config`、`permissions`、`changelog` 全部走过真实 CLI。积分在本次账号返回无数据。一次更新日志有 250,872 个字符，已将长报告做成可回看的分页。|
| 性能 | 原实现对应的完整 `agy -p /usage` 三次用时 8.28、6.24、6.03 秒，均为零模型回合。分段测量一次，终态结果在 5.588 秒到达，进程在 6.663 秒退出。修改后以真实 CLI 测得首次查询 4.166 秒，同会话 `/quota` 命中缓存低于 1 毫秒，`/usage refresh` 4.487 秒。这些是本机样本，网络与服务端时间可变。|
| 组合与表单 | 原先带任务的 `/plan` 会被插件剥掉前缀并改成持久模式。现在连同后面的命令、参数和图片一起交给原生执行。实测 ACP 的访谈把选项和自由输入编码成 `q1` 与可选 `q1_other`，现合并为一个问题。回归覆盖枚举值、自填答复和多文本块。真实 dsh-tui 提交组合命令、选择访谈回答后，在临时会话 brain 目录中生成了计划 Markdown；临时工作区保持为空。|
| 入口冲突 | `agents`、`compact`、`config`、`hooks`、`skills` 与宿主静态命令同名，`goal` 还受宿主能力路由影响。需要明确调用 agy 时用 `/agy <命令>`。`/agy commands` 显示当前会话的目录。|
| 插件提供的其他界面 | `diff`、`tasks`、`commands`、`native` 为会话报告；`account` 提供账号操作。对 `plugins`、`mcp`、`remote`、`team`、`folders`、`codesearch`、`artifacts` 逐项检查分发；MCP 和插件增删改用真实 agy 和临时 HOME 复验。真实终端另验证了配额缓存与刷新、配置写入、登录界面与两个模拟身份切换。登录、远程设备注册、子代理启动属于不同操作，不能用只读查询通过推断它们都已复验。|

**官方 TUI 与插件入口的对应关系**

- 会话与配置：新建、恢复、模型和强度选择可用宿主的 `/new`、`/resume`、`/model`、`/effort`；附加目录用 `/agy folders`，产物预览用 `/agy artifacts`，搜索用 `/codesearch <内容>`。原生单次覆盖模型、会话改名/分叉/回滚、逐项批注和搜索结果跳外部编辑器请在官方 CLI 办理。
- 宿主自有交互：帮助、复制、退出、快捷键和终端显示由 dsh-tui 处理。官方的 `/keybindings`、`/statusline`、`/title`、`/open`、`/feedback`、`/voice` 仍用官方终端。账号登录和切换支持 `/login`；清除原生凭据的 `/logout` 仍由 agy 处理。
- 后台和计划：`/agy tasks` 展示当前 ACP 会话推送的活动，`/agy team` 提供子代理预览。原生任务管理器、`/swarm board`、独立 `/btw` 和完整 `/context` 图表仍需原生 CLI。本次账号未向 ACP 公布 `boost` 或 `teamwork`。管理远程服务使用 `/agy remote`；本轮没有启动或注销真实设备。
- 对带参数的变体逐项看语义。比如 `/agy skills` 是查看技能，原生 `/skills reload` 是重载。需要终端专属变体时，可用 `/agy native` 获取同会话的往返命令。




- **真实 TUI** 已验证内核选择、真实模型回复、工作区编辑、工作区外编辑的允许和拒绝、拒绝后的继续对话、Esc 中断，以及中断后开启新回合。安装期间和卸载后，Codex 都能完成真实模型回合。
- **配额和登录** 已用 PTY 验证 `/usage` 能显示真实模型组和剩余量，无凭据时 `/login` 能显示官方 Google 链接及掩码问题。用户已用一个真实 Google 账号完成登录。WSL 的默认浏览器实际访问了临时本机校验页；80×24 真实终端在无滚动状态下显示授权链接及复制、重新打开操作，两种操作均使用同一条完整 Google URL。两个模拟身份已在真实 dsh-TUI 中完成“首次登录 → 对话 → 切换 → 新会话对话”。双真实 Google 账号切换未实测，按此口径完成本轮验收。已用真实 agy 在临时 HOME 验证无效授权码会返回可重试的错误。首次成功、切换后恢复、旧会话不可用、浏览器回调失败和取消均有协议回归测试。
- **原生会话** 实测 TUI → 官方 CLI → TUI 往返、跨前端记忆和恢复后工作目录。已实测切换模型、强度及计划模式、识别图片颜色。agy 1.5.13 在一轮执行期间接受了第二条 prompt 并输出更正内容。实测 `/agy goal` 在临时工作区创建并读回含随机内容的文件，`/compact` 的原生请求成功结束；计划模式生成的真实实施计划能在产物面板读回校验词。原生提问能在 dsh 表单回答，所选自定义智能体能返回仅在预设中写入的随机校验词。附加目录内的测试文件读取成功；移除后另一份随机文件触发审批，拒绝后未读取。真实 ACP 握手、账户模型目录和回合会耗用本机登录及相应额度。
- **管理操作** 在临时 HOME 中通过真实 agy 添加、停用、删除 MCP 服务和本地测试插件。真实 dsh-TUI 逐项确认后写入测试 HOME。另用已授权的 agy 通过临时 `--settings` 覆盖文件读回执行模式和权限规则，两项查询均为零模型回合。已实测远程服务状态查询，启动和注销涉及真实设备注册，仅在明确确认后执行。

一次性 `/agy schedule` 在发起回合返回后唤醒 agy，真实 dsh-TUI 显示了它从测试文件读取的随机校验词，任务面板显示完成。另用原生钩子限制只允许注册一个非守护 cron（每分钟一次、最多两次），两次触发分别读回测试文件，会话收到含随机校验词及不同迭代号的两条回复。工作区自定义 `SKILL.md` 的斜杠入口也已在真实 TUI 验证。原生 `run_workflow` 的单步 Python 脚本经单次审批返回正确计算结果；`/agy browser` 在 WSL 连接独立的临时 Chromium，通过页面渲染读回随机值。浏览器功能需要同一运行环境具有可连接的 Chrome；本次测试使用独立浏览器资料目录。[原生计时器](https://antigravity.google/docs/commands/schedule) · [原生浏览器要求](https://antigravity.google/docs/commands/browser)

双子代理验收在一个独立工作区完成。测试用原生工具钩子将直接创建数限制为两个，并记录两个不同的子会话 ID。两人各自读取一份随机文件并向父会话发回消息。在首次观察窗口中父会话没有给出合并回复；恢复同一会话并追问后，父会话正确返回了两份校验词。真实 dsh-TUI 已显示父会话的合并结果；在 `/agy team` 中分别点开两个 ID，均读到对应子代理的工具记录和正确回复。此流程只创建了两个子代理。子代理预览依据 agy 1.5.13 的本机日志格式；若原生格式发生变化，面板可能无法列出子会话。[官方会话日志位置](https://antigravity.google/docs/hooks)

在仓库中可复现以下检查。

```sh
npm ci
npm test
node test/live-management.mjs
node test/live-settings.mjs
node test/live.mjs
```

前两项准备依赖并进行无凭据的协议回归。管理检查使用本机 agy 和临时 HOME。最后一项需要已登录账号，消费两个真实模型回合，在临时工作区核对目录范围、原生 CLI 续聊和历史回放。配置读回检查需要已登录账号。原生测试会话由 agy 保存。

真实终端检查可在已安装本插件的测试 profile 下运行，将 `DSH_HOME` 指向该 profile 所在的 dsh 根目录（包含 `profiles/dsh-tui`）。检查会打开三个临时 TUI，依次查配额、在隔离的 HOME 确认一项配置、在无登录态下打开登录并取消。

```sh
DSH_HOME=/path/to/test-dsh uv run --no-project --with pyte --with pexpect test/tui_smoke.py
```

同一测试命令使用 `--login` 可单独检查 80×24 登录首屏、复制和重开；使用 `--accounts` 可在真实 TUI 中跑两个模拟身份的切换。测试使用临时浏览器和剪贴板记录程序断言完整 URL，避免影响日常桌面。使用 `--stack` 可通过真实 agy 验证组合命令、访谈回答和计划文件。已登录的终端测试将凭据复制到临时 HOME，在其中创建会话与产物，结束后清理。追加 `--workflows` 可验证临时工作区技能和一次性定时器的界面回复及任务状态。这一组需要已登录账号并会使用模型额度。
