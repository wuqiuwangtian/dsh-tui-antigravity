# 发布与兼容性维护

发布前同步更新 package.json、锁文件根包和 dsh-plugin.json 中的版本，在干净 WSL profile 里复验真实登录入口、对话、配额和恢复。日常 CI 使用模拟身份；上游监测的实际 agy 握手无需登录。兼容性按 README 表中实测版本声明。

## 发布

首次由有权限的 npm 维护者用已登录的 npm CLI 发布。在测试通过的提交打标签并推送后，从同一干净提交运行 `bash scripts/publish.sh`。它将 tarball 提交到 npm，下载核对字节后把同一文件和 SHA256SUMS 放进 GitHub Release。若 npm 版本已存在，脚本先比较内容，发现冲突即退出。

后续可在 npm 包设置中将 GitHub 仓库 `wuqiuwangtian/dsh-tui-antigravity` 的 `publish.yml` 配置为 Trusted Publisher，允许发布。建议在下次实际发布前设置，npm 要求新的绑定在两天内成功发布一次。每次从新的已推送标签手动触发：

```sh
gh workflow run publish.yml --ref vX.Y.Z
```

发布后在干净 profile 里按包名安装，核对实际安装版本。GitHub 附件和 npm 分别下载后的 SHA-256 应相同。若工作流中断，先核对已生成的版本和附件，再从原标签重试。

## 上游变更

`compat.yml` 每天读取 npm stable 与 agy 官方 Linux amd64 清单，按版本及已测试代码提交缓存成功结果。手动运行会跳过缓存直接复验；勾选 candidate 可在首次发布或回归定位时验证当前提交打出的包。后端、UI、agy 三个结果分别展示。新宿主的 UI 检查在一次性 profile 中试打补丁并撤销。通过检查后，再核对实际终端效果和更新生产脚本的版本限制；测试本身不会放宽用户安装的版本限制。真实账号的模型、配额及历史恢复见[验收记录](verification.md)。

日常排查先打开失败组件的 Actions 日志。对照 npm 上实际发布的插件版本重现，修复后在稳定宿主和候选宿主上复验。仅在需要改动分发内容时发布插件新版本。
