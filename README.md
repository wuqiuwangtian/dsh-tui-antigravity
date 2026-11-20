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

已有 agy 登录会被复用。首次登录或切换已有 Google 账号时，输入 `/login`，或在 `/agy account` 选择「登录或切换 Google 账号」。TUI 会请求系统默认浏览器打开 Google 授权页；WSL 下优先调用 Windows 的默认浏览器。首屏有可点击的 Google 链接、「复制完整授权链接」和「重新打开浏览器」，选好账号后直接粘贴回跳网址或一次性授权码即可。插件把答案经 stdin 交给本机 `agy acp --login`，由 agy 完成授权和存储。Esc 取消操作。首次成功后输入 `/new`，让宿主对正式会话 ID 加锁。切换时先结束当前回合。Google 授权成功后，插件关闭旧账号的 ACP 进程，再用新连接核对原生会话目录。如果无法恢复原会话，账号面板和输入框会提示使用 `/new` 或会话选择器。取消授权或授权失败时，可继续使用原连接。账号是本机 CLI 共享状态。[官方认证和 ACP 接口](https://antigravity.google/docs/ide/extensions/acp)

## 在 TUI 中使用

| 场景 | 入口及行为 |
| --- | --- |
| 配额与积分 | `/usage`、`/quota` 展示每个模型组实际返回的剩余额度、周期和重置时间，支持刷新和关闭。`/credits` 显示积分或账号未提供数据。数据来自 agy 的 headless 命令结果，要求模型回合数为零。 |
| Antigravity 功能菜单 | `/agy`。当同名命令由 dsh-TUI 接管时，使用 `/agy config`、`/agy permissions`、`/agy hooks`、`/agy skills`、`/agy agents` 等明确选择 Antigravity。报告可刷新、翻页。`/agy account` 显示服务端提供的套餐。 |
| 全局配置与权限 | `/agy config` 展示执行模式、产物评审策略、工具权限、终端沙箱、工作区外访问五项生效值，可逐项编辑或恢复继承。`/agy permissions` 可查看各层规则，向全局 `deny`、`ask`、`allow` 增删一条规则。每次写入前展示字段、改动和目标路径，默认选中取消。目标文件为 `~/.gemini/antigravity-cli/settings.json`，新启动的官方 agy 也会读取。 |
| 工作目录和智能体 | `/agy folders` 在当前会话添加或移除附加目录，保留会话 ID，恢复后按 agy 的权限规则处理。`/agy agents` 展示原生工作区发现的预设，选中预设后，同一界面和工作区下一次 `/new` 使用它。 |
| 计划产物 | `/artifacts`、`/agy artifacts` 在 dsh 面板翻页预览当前原生会话产物目录顶层的 Markdown 文件，包括实施计划。产物由 agy 创建，可返回聊天发送反馈。读回采用官方 CLI 默认的数据目录。[原生会话文件位置](https://antigravity.google/docs/hooks) |
| 搜索代码 | `/codesearch <表达式>` 或 `/agy codesearch`。在当前工作区用 ripgrep (`rg`) 搜索，支持智能大小写、`-F` 字面匹配及 `f:`、`-f:` 路径过滤。结果可翻页并预览上下行，每次最多显示 120 处；无模型调用。 |
| 远程控制 | `/agy remote` 查看官方守护进程状态。注册本机并启动（仅本次系统登录有效）、停止并注销均调用官方子命令并需二次确认。浏览器中的设备控制仍由 Google 提供。 |
| 扩展管理 | `/agy plugins` 安装、启停及卸载原生插件。`/agy mcp` 新建基本 stdio/HTTP 服务、启停及移除，执行前显示命令并确认。宿主 `/mcp` 也能查询原生服务。选择带环境变量或请求头的添加入口，可在掩码框输入字符串键值表。确认面板列出键名；值通过本机 agy 的进程参数传入，由 agy 保存。 |
| 后台任务 | `/agy tasks` 展示当前会话收到的计时器、动态工作流及后台智能体调用状态，可刷新。一次性定时器触发后，回复和审批仍能到达当前会话。后台调用的状态来自 agy 的工具事件。`/agy team` 可选中一个直接子代理，翻页或刷新其可见回复和工具记录。列表先核对父会话的创建记录，打开时再核对来自父会话的原生消息。该面板适用于默认本机资料目录。 |
| 模型与执行 | 模型、思考强度和权限模式从当前 ACP 会话读取，变更后以服务端返回值为准。`/plan`、`/plan off` 切换原生模式。agy 公布 compact 后可使用宿主的 `/compact`。`/agy commands` 列出当前会话动态公布的命令；可用 `/agy <命令> [参数]` 调用它们，包括本机观察到的 compact、goal、schedule、browser、swarm 等。具体可用性随账号、版本和配置变化。 |
| 聊天与工具 | 流式文本和思考、图片输入、工具调用和 diff、原生权限审批、ACP 表单问题、取消、排队和回合内引导。`/agy diff` 汇总当前会话已完成的工具结果中有前后文本的编辑。文件操作是否需要审批由 agy 决定。[官方权限规则](https://antigravity.google/docs/permissions) |
| 历史与会话 | `dsh-tui --backend antigravity --resume <id>`、宿主会话浏览器、官方 `agy --conversation <id>` 使用同一份原生历史。恢复前核对目录和身份，避免误开空会话。退出时显示恢复命令。`/agy native` 显示当前会话专用的往返命令，方便使用原生终端专属功能。同一测试 profile 的第二个 dsh-TUI 会提示会话被占用。官方 agy 在第一个 TUI 挂载期间仍能在同一会话完成新回合，宿主的占用锁只约束 dsh-TUI。跨前端接力时先退出已有写入端。 |

## 验收证据

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

同一测试命令使用 `--login` 可单独检查 80×24 登录首屏、复制和重开；使用 `--accounts` 可在真实 TUI 中跑两个模拟身份的切换。测试使用临时浏览器和剪贴板记录程序断言完整 URL，避免影响日常桌面。追加 `--workflows` 可验证临时工作区技能和一次性定时器的界面回复及任务状态。这一组需要已登录账号并会使用模型额度。

## 与官方 CLI 的差距

| 功能 | 当前边界及原因 |
| --- | --- |
| 原生会话改名、分叉、删除、归档、回滚 | 1.5.13 对 session/set_info、fork、delete、archive、rewind 的 ACP 探测均返回 -32601。在临时真实会话中，官方 print 模式也明确拒绝 /fork 和 /rename。官方交互 CLI 有 /fork、/rename 和 /resume 浏览器的 F2 Rename、F4 Delete。保留原生语义，暂从官方 CLI 办理。Codex 的归档和 agy 的删除有不同的数据保留语义。[原生会话管理](https://antigravity.google/docs/cli/conversations/) |
| 第三方模型 | 当前客户端只展示 agy 向它公布的模型。官方明确限定哪些 ACP 编辑器可用第三方模型。[官方客户端与模型范围](https://antigravity.google/docs/ide/extensions/acp) |
| 终端专属交互 | 语音、CLI 状态栏、终端标题、原生任务监视器和完整子代理管理器等依赖原生终端、后台服务或特定 UI。本机可通过 `/agy commands` 查看会话实际上报的命令。可以查看计时器及子代理活动和直接子代理记录。原生任务的逐项停止、子代理消息单独投递、产物逐行批注和快捷键跳转外部编辑器仍用原生 CLI。原生 `/btw` 的独立临时问答和 `/context` 的详细分类均未通过 ACP 提供，宿主只能展示 ACP 实际推送的上下文总量。搜代码面板提供匹配预览。 |
| 配置编辑与集成 | 界面可编辑上表的五个全局字段及权限规则。原生 `--remote-agent` 和 `--project` 没有对应的本机 ACP 启动选项。其他高级配置和 hook 编写仍用原生入口。插件不维护第二套账户、配额、任务或历史数据库。 |
| 仍待验证 | 授权失效后的真实恢复、WSL 以外的平台、双真实 Google 账号切换及大规模历史。历史回放可重建 ACP 返回的图片字节；本机 agy 1.5.13 的真实图片对话在恢复时未返回原图，旧图片只在提供字节时可见。动态出现的 ACP 命令只表示原生可调用，一次性定时器、限定两次的重复 cron、读取本地网页和单步动态工作流已有实测。远程业务网页及长期运行的大型工作流尚未逐项实测。 |

对标参考为 [dsh-TUI v0.20.2 的 Codex 后端](https://github.com/ccch1mneyyy/dsh-TUI/blob/v0.20.2/docs/codex-backend.md)、[宿主后端插件契约](https://github.com/ccch1mneyyy/dsh-TUI/tree/v0.20.2/scripts/fixtures/third-party-backend) 和 [Antigravity 官方配额面板](https://antigravity.google/docs/cli/commands/usage)。
