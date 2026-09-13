# 开发说明

**简体中文** · [English](DEVELOPMENT.md)

[产品介绍](README.md) · [贡献指南](CONTRIBUTING.zh-CN.md)

本文介绍 what-the-repo 的开发环境、代码目录和部署配置。在线体验请访问 [what-the-repo](https://bottlecapduel.com)。

## 代码目录

- `server/`：TypeScript/Node.js、Fastify、Pi Agent 运行时、静态分析、PostgreSQL 持久化、Redis/BullMQ 任务投递及对象存储适配器。
- `web/`：React/Vite 工作台、对话界面、代码证据与架构视图。
- `evolution/pi/`：在隔离环境中生成候选，由人工审核后更新 Skill。
- `eval/`：确定性测试样本与评测用例。
- `infra/`、`compose*.yaml`、`scripts/`：开发、验证与部署配置和脚本。

产品分析不可信仓库时，不执行目标仓库的安装、构建、测试、Hook 或插件脚本。

## 本机开发

使用 Node.js 22.19 或更高版本，当前 CI 使用 Node.js 24。分别在 `server/`、`web/` 和 `evolution/pi/` 目录运行 `npm ci`，安装这三个产品模块的依赖。

本机开发通过 Docker 运行 PostgreSQL 和 Redis，API、分析 Worker 与 Vite 则在主机运行。Windows 上的配置保存在 Git 忽略的 `.secrets/local.env` 中，变量说明见 `.env.example`。

请使用自己的开发用 GitHub OAuth 应用、回调地址和模型厂商凭据。默认 Web 地址对应的 OAuth 回调为：

```text
http://127.0.0.1:5307/api/auth/github/callback
```

测试 OAuth 应用应与正式环境的应用分开。不要提交填写了凭据的环境文件。

```powershell
New-Item -ItemType Directory -Force .secrets
# 仅首次配置时复制，不覆盖已有凭据。
if (-not (Test-Path .secrets/local.env)) { Copy-Item .env.example .secrets/local.env }
# 填写 .secrets/local.env 后再启动。
powershell -ExecutionPolicy Bypass -File scripts/start-local-dev-deps.ps1
```

Web 默认地址为 `http://127.0.0.1:5307`，API 默认地址为 `http://127.0.0.1:8307`。

## 配置与部署

项目配置变量使用 `WHAT_THE_REPO_*` 前缀，GitHub OAuth 变量仍为 `GITHUB_OAUTH_*`。填写后的环境文件与凭据文件留在本机，由 Git 忽略。示例域名、存储桶和账号 ID 需要替换成自己的值。如需显示备案信息，在构建 Web 镜像前将可选变量 `VITE_ICP_RECORD` 设为自己的公开备案编号；留空时页脚不显示该信息。

Docker 为主机开发提供 PostgreSQL 和 Redis。完整 Compose 配置用于整套集成测试；`infra/k8s/` 和 k3s 脚本描述在线产品的单节点部署。CI 检查代码和配置，不发布或部署应用。

## 许可检查

修改依赖或素材后，在仓库根目录运行 `node scripts/check-license-inventory.mjs`。详见[许可记录维护](licenses/README.zh-CN.md)、[第三方声明](THIRD_PARTY_NOTICES.zh-CN.md)和[分发说明](licenses/DISTRIBUTION.zh-CN.md)。
