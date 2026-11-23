# Antigravity 使用手册

## 账号与授权

已有 agy 登录会被复用。首次登录或切换已有 Google 账号时，输入 `/login`，或在 `/agy account` 选择「登录或切换 Google 账号」。TUI 会请求系统默认浏览器打开 Google 授权页；WSL 下优先调用 Windows 的默认浏览器。首屏有可点击的 Google 链接、「复制完整授权链接」和「重新打开浏览器」，选好账号后直接粘贴回跳网址或一次性授权码即可。插件把答案经 stdin 交给本机 `agy acp --login`，由 agy 完成授权和存储。Esc 取消操作。首次成功后输入 `/new`，让宿主对正式会话 ID 加锁。切换时先结束当前回合。Google 授权成功后，插件关闭旧账号的 ACP 进程，再用新连接核对原生会话目录。如果无法恢复原会话，账号面板和输入框会提示使用 `/new` 或会话选择器。取消授权或授权失败时，可继续使用原连接。账号是本机 CLI 共享状态。[官方认证和 ACP 接口](https://antigravity.google/docs/ide/extensions/acp)

## 在 TUI 中使用

| 场景 | 入口及行为 |
| --- | --- |
| 配额与积分 | `/usage`、`/quota` 展示每个模型组实际返回的剩余额度、周期和重置时间，结果显示在聊天记录中。同一会话在 60 秒内复用已查询的配额，缓存命中会标注查询时间。输入 `/usage refresh` 强制重新查询。`/credits` 显示积分或账号未提供数据。数据来自 agy 的 headless 命令结果，要求模型回合数为零。 |
| Antigravity 功能菜单 | `/agy`。当同名命令由 dsh-TUI 接管时，使用 `/agy config`、`/agy permissions`、`/agy hooks`、`/agy skills`、`/agy agents` 等明确选择 Antigravity。长报告末尾提供翻页命令。`/agy account` 显示服务端提供的套餐。 |
| 全局配置与权限 | `/agy config` 展示执行模式、产物评审策略、工具权限、终端沙箱、工作区外访问五项生效值，可逐项编辑或恢复继承。`/agy permissions` 可查看各层规则，向全局 `deny`、`ask`、`allow` 增删一条规则。每次写入前展示字段、改动和目标路径，默认选中取消。目标文件为 `~/.gemini/antigravity-cli/settings.json`，新启动的官方 agy 也会读取。 |
| 工作目录和智能体 | `/agy folders` 在当前会话添加或移除附加目录，保留会话 ID，恢复后按 agy 的权限规则处理。`/agy agents` 展示原生工作区发现的预设，选中预设后，同一界面和工作区下一次 `/new` 使用它。 |
| 计划产物 | `/artifacts`、`/agy artifacts` 在 dsh 面板翻页预览当前原生会话产物目录顶层的 Markdown 文件，包括实施计划。产物由 agy 创建，可返回聊天发送反馈。读回采用官方 CLI 默认的数据目录。[原生会话文件位置](https://antigravity.google/docs/hooks) |
| 搜索代码 | `/codesearch <表达式>` 或 `/agy codesearch`。在当前工作区用 ripgrep (`rg`) 搜索，支持智能大小写、`-F` 字面匹配及 `f:`、`-f:` 路径过滤。结果可翻页并预览上下行，每次最多显示 120 处；无模型调用。 |
| 远程控制 | `/agy remote` 查看官方守护进程状态。注册本机并启动（仅本次系统登录有效）、停止并注销均调用官方子命令并需二次确认。浏览器中的设备控制仍由 Google 提供。 |
| 扩展管理 | `/agy plugins` 安装、启停及卸载原生插件。`/agy mcp` 新建基本 stdio/HTTP 服务、启停及移除，执行前显示命令并确认。宿主 `/mcp` 也能查询原生服务。选择带环境变量或请求头的添加入口，可在掩码框输入字符串键值表。确认面板列出键名；值通过本机 agy 的进程参数传入，由 agy 保存。 |
| 后台任务 | `/agy tasks` 展示当前会话收到的计时器、动态工作流及后台智能体调用状态，再次输入该命令即可查看最新状态。一次性定时器触发后，回复和审批仍能到达当前会话。后台调用的状态来自 agy 的工具事件。`/agy team` 可选中一个直接子代理，翻页或刷新其可见回复和工具记录。列表先核对父会话的创建记录，打开时再核对来自父会话的原生消息。该面板适用于默认本机资料目录。 |
| 模型与执行 | 模型、思考强度和权限模式从当前 ACP 会话读取，变更后以服务端返回值为准。`/plan`、`/plan off` 切换原生模式。agy 公布 compact 后可使用宿主的 `/compact`。`/agy commands` 列出当前会话动态公布的命令；可用 `/agy <命令> [参数]` 调用它们，包括本机观察到的 compact、goal、schedule、browser、swarm 等。具体可用性随账号、版本和配置变化。 |
| 聊天与工具 | 流式文本和思考、图片输入、工具调用和 diff、原生权限审批、ACP 表单问题、取消、排队和回合内引导。`/agy diff` 汇总当前会话已完成的工具结果中有前后文本的编辑。文件操作是否需要审批由 agy 决定。[官方权限规则](https://antigravity.google/docs/permissions) |
| 历史与会话 | `dsh-tui --backend antigravity --resume <id>`、宿主会话浏览器、官方 `agy --conversation <id>` 使用同一份原生历史。恢复前核对目录和身份，避免误开空会话。退出时显示恢复命令。`/agy native` 显示当前会话专用的往返命令，方便使用原生终端专属功能。同一测试 profile 的第二个 dsh-TUI 会提示会话被占用。官方 agy 在第一个 TUI 挂载期间仍能在同一会话完成新回合，宿主的占用锁只约束 dsh-TUI。跨前端接力时先退出已有写入端。 |

## 组合命令与报告

输入 `/plan /grill-me 为新用户设计欢迎页`，整条提示会发送给 agy，由它主持访谈、生成计划并等待审阅。若输入框中另一个同名命令由宿主接管，使用 `/agy plan /grill-me 为新用户设计欢迎页` 显式指定 Antigravity。访谈每个选择题支持选推荐项或填写自定义答案。单独的 `/plan`、`/plan on`、`/plan off` 继续用作会话模式开关。[官方访谈与组合命令](https://antigravity.google/docs/commands/grill-me/)

`/agy commands` 列出当前会话实际公布的原生命令以及插件的管理入口。只读报告写入聊天记录；长输出按页展示，照行末提示输入 `/agy changelog page 2` 等命令读下一页。翻页复用上一次结果。要修改配置、选智能体或切换账号，请分别打开 `/agy config`、`/agy agents`、`/agy account` 的操作菜单。

## 与官方 CLI 的差距

| 功能 | 当前边界及原因 |
| --- | --- |
| 原生会话改名、分叉、删除、归档、回滚 | 1.5.13 对 session/set_info、fork、delete、archive、rewind 的 ACP 探测均返回 -32601。在临时真实会话中，官方 print 模式也明确拒绝 /fork 和 /rename。官方交互 CLI 有 /fork、/rename 和 /resume 浏览器的 F2 Rename、F4 Delete。保留原生语义，暂从官方 CLI 办理。在 1.5.14 上复核，session/delete 和 session/archive 仍返回 -32601。安装本项目的 0.20.2 快捷命令补丁后，宿主会话列表的 Ctrl+D 会显示原生删除步骤。[原生会话管理](https://antigravity.google/docs/cli/conversations/) |
| 第三方模型 | 当前客户端只展示 agy 向它公布的模型。官方明确限定哪些 ACP 编辑器可用第三方模型。[官方客户端与模型范围](https://antigravity.google/docs/ide/extensions/acp) |
| 终端专属交互 | 语音、CLI 状态栏、终端标题、原生任务监视器和完整子代理管理器等依赖原生终端、后台服务或特定 UI。本机可通过 `/agy commands` 查看会话实际上报的命令。可以查看计时器及子代理活动和直接子代理记录。原生任务的逐项停止、子代理消息单独投递、产物逐行批注和快捷键跳转外部编辑器仍用原生 CLI。原生 `/btw` 的独立临时问答和 `/context` 的详细分类均未通过 ACP 提供，宿主只能展示 ACP 实际推送的上下文总量。搜代码面板提供匹配预览。 |
| 配置编辑与集成 | 界面可编辑上表的五个全局字段及权限规则。原生 `--remote-agent` 和 `--project` 没有对应的本机 ACP 启动选项。其他高级配置和 hook 编写仍用原生入口。插件不维护第二套账户、配额、任务或历史数据库。 |
| 仍待验证 | 授权失效后的真实恢复、WSL 以外的平台、双真实 Google 账号切换及大规模历史。历史回放可重建 ACP 返回的图片字节；本机 agy 1.5.13 的真实图片对话在恢复时未返回原图，旧图片只在提供字节时可见。动态出现的 ACP 命令只表示原生可调用，一次性定时器、限定两次的重复 cron、读取本地网页和单步动态工作流已有实测。远程业务网页及长期运行的大型工作流尚未逐项实测。 |

对标参考为 [dsh-TUI v0.20.2 的 Codex 后端](https://github.com/ccch1mneyyy/dsh-TUI/blob/v0.20.2/docs/codex-backend.md)、[宿主后端插件契约](https://github.com/ccch1mneyyy/dsh-TUI/tree/v0.20.2/scripts/fixtures/third-party-backend) 和 [Antigravity 官方配额面板](https://antigravity.google/docs/cli/commands/usage)。

恢复旧会话时，如果 agy 记录的原工作区已移动或无法访问，界面会显示原路径。选择使用当前目录，或输入其他目录，再核对完整路径并确认。确认前不会加载旧会话或运行工具。取消后可以输入 `/workspace` 重选，也可以用 `/new` 新建会话。
