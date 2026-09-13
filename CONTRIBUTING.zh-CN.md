# 参与贡献

**简体中文** · [English](CONTRIBUTING.md)

[返回产品介绍](README.md)


## 修改与提交 PR

1. 如果计划较大的产品或架构变更，先提交 Issue，说明要解决的问题及预期行为。
2. Fork 本仓库，创建分支，围绕一个明确的目标修改。不要加入凭据、本地数据库、内部协作文档或生成的运行产物。
3. 运行与改动相关的检查。后端：`npm run build && npm test`；Web：`npm run build && npm test && npm run lint`；Evolution：`npm run build && npm test`。各命令在对应模块目录执行；另外在仓库根目录运行 `node scripts/check-license-inventory.mjs`。
4. 创建 Pull Request（PR，合并请求），说明问题、修改后的行为和验证结果。界面有变化时附上截图。检查尚未通过时，也可以先创建草稿 PR。

GitHub 会在 PR 创建后运行 CI（自动检查）。检查通过后，由维护者审核并合并。PR 检查使用测试配置，不连接正式服务或付费模型，也不部署应用。

提交标题使用 Conventional Commits 格式，例如 `fix: restore cancelled analysis jobs`、`feat: add an evidence filter`、`docs: explain local setup` 或 `ci: update quality checks`。维护者可在压缩合并时统一最终标题。

## 依赖与来源声明

新增依赖时请说明用途。修改依赖或第三方素材时，同步更新锁文件、许可清单和相关声明，保留已有版权及修改说明。许可检查会提示哪些清单记录需要更新。具体要求见[许可记录维护](licenses/README.md)。

## 社区与安全

参与 Issue、PR 和讨论时，请遵守[社区行为规范](CODE_OF_CONDUCT.zh-CN.md)。发现漏洞时，请按[安全报告说明](SECURITY.zh-CN.md)私下联系我。
