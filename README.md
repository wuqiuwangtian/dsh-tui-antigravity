# dsh-tui-antigravity

在 dsh-tui 的终端界面中使用本机 Antigravity CLI。可以复用 Google 登录、用 `/usage` 看配额、审批工具调用，并在 dsh-tui 与官方 agy 之间续聊同一段历史。本项目由社区维护。

![Antigravity 在 dsh-tui 中的启动页](ui/previews/144x52.png)

## 安装

首版验收环境为 WSL、dsh-tui 0.20.2、dsh 0.2.2-rc.5 和 agy 1.5.13。先确保当前终端能运行 `dsh-tui`、`dsh`、`pnpm` 和 `agy acp --help`。Node.js 版本遵循 dsh-tui 的要求。首次使用 dsh-tui，请先单独启动一次，完成宿主初始化后退出。

```sh
dsh plugin --profile dsh-tui add https://github.com/wuqiuwangtian/dsh-tui-antigravity/releases/download/v0.1.0/dsh-tui-antigravity-0.1.0.tgz
dsh-tui --backend antigravity
```

已登录 agy 的用户可以直接发送第一句话，随后输入 `/usage` 检查配额。首次登录时输入 `/login`，按提示完成 Google 授权，回到 TUI 输入 `/new`。浏览器未弹出时，登录页提供打开和复制链接入口。后续也可从启动页或 `/kernel` 选择 Antigravity。

## 启用配套启动页

退出 dsh-tui 后，在 WSL 中运行以下命令。需要 Git。脚本把配色、像素标题和吉祥物应用到当前 profile 的宿主；品牌设置选择「跟随后端」即可看到效果。

```sh
plugin_dir="${DSH_HOME:-$HOME/.dsh}/profiles/dsh-tui/node_modules/dsh-tui-antigravity"
sh "$plugin_dir/ui/brand.sh"
dsh-tui --backend antigravity
```

UI 补丁适配 dsh-tui 0.20.2。其他版本可先使用默认界面。重装同一版宿主后可重新应用；升级宿主前建议先撤销补丁。

## 卸载

如已安装配套启动页，先退出 dsh-tui 并运行第一条命令，再卸载插件。

```sh
sh "${DSH_HOME:-$HOME/.dsh}/profiles/dsh-tui/node_modules/dsh-tui-antigravity/ui/brand.sh" remove
dsh plugin --profile dsh-tui remove dsh-tui-antigravity
```

## 使用与反馈

- 用 `/agy` 打开 Antigravity 功能菜单，使用 `dsh-tui --backend antigravity --resume <id>` 恢复会话。可通过 `ANTIGRAVITY_EXECUTABLE` 指定 agy 的绝对路径。
- 原生会话改名、分叉和删除等操作仍需在官方 CLI 中完成。Windows 原生和 macOS 端到端流程、两个真实 Google 账号切换尚待实测。详见[功能与限制](docs/usage.md)和[验收记录](docs/verification.md)。
- [提交问题](https://github.com/wuqiuwangtian/dsh-tui-antigravity/issues)时请附系统、终端、dsh-tui 和 agy 的版本，以及出现问题的步骤。贴日志前请删去授权链接、令牌、账号和私有路径。

插件代码采用 [MIT](LICENSE) 许可。宿主补丁所含上游代码的版权与许可见[第三方声明](THIRD-PARTY-NOTICES.md)。
