# 参与贡献

**简体中文** · [English](CONTRIBUTING.md)

[返回产品介绍](README.md)

本仓库包含 what-the-repo 在线 Web 产品。单独的离线版或桌面版不属于当前范围。


## 修改与提交 PR

1. 如果计划较大的产品或架构变更，先提交 Issue，说明要解决的问题及预期行为。
2. Fork 本仓库，创建分支，围绕一个明确的目标修改。不要加入凭据、本地数据库、内部协作文档或生成的运行产物。
3. 运行与改动相关的检查。后端：`npm run build && npm test`；Web：`npm run build && npm test && npm run lint`；Evolution：`npm run build && npm test`。各命令在对应模块目录执行；另外在仓库根目录运行 `node scripts/check-license-inventory.mjs`。
4. 创建 Pull Request（PR，合并请求），说明问题、修改后的行为和验证结果。界面有变化时附上截图。检查尚未通过时，也可以先创建草稿 PR。

GitHub 会在 PR 创建后运行 CI（自动检查）。检查通过可供维护者评审参考，合并前仍需人工审核。普通 PR 检查不会取得正式环境或付费模型的凭据，也不会部署应用。

提交标题使用 Conventional Commits 格式，例如 `fix: restore cancelled analysis jobs`、`feat: add an evidence filter`、`docs: explain local setup` 或 `ci: update quality checks`。维护者可在压缩合并时统一最终标题。贡献者不需要访问在线服务的服务器或密钥。

## 依赖与来源声明

新增依赖时请说明用途。修改依赖或第三方素材时，同步更新锁文件、许可清单和相关声明，保留已有版权及修改说明。清单记录了依赖描述文件的准确摘要，文件变化后会提示记录过期。具体要求见[许可记录维护](licenses/README.md)。

## 社区与安全

参与 Issue、PR 和讨论时，请遵守[社区行为规范](CODE_OF_CONDUCT.zh-CN.md)。安全修复支持范围和私下报告漏洞的方式见[安全报告说明](SECURITY.zh-CN.md)。不要在公开 Issue 中发布凭据、私有源码或漏洞细节，也不要使用其他用户的数据进行测试。
