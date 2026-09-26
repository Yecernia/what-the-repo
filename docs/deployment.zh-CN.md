# 部署说明

**简体中文** · [English](deployment.md)

这里运行的是和 [what-the-repo.com](https://what-the-repo.com) 同一套 Web 产品，可以放在自己的电脑或服务器上。没有单独的桌面版或个人版。本机开发请看[贡献指南](../CONTRIBUTING.zh-CN.md)。

## 准备

- 支持 Linux 容器的 Docker，以及 Docker Compose 2.24.4 或更新版本。
- 自己的 GitHub OAuth 应用和模型配置。

## 配置

把 `.env.example` 复制为被 Git 忽略的 `.secrets/runtime.env`，换成你自己的数据库密码、会话与加密密钥、OAuth 应用和模型配置。

- 容器模式下设置 `WHAT_THE_REPO_REDIS_URL=redis://redis:6379`。
- 在 OAuth 应用里登记回调地址 `<WHAT_THE_REPO_WEB_URL>/api/auth/github/callback`。本机为 `http://127.0.0.1:5307/api/auth/github/callback`，不是内部 API 端口。
- 对外提供服务时，设置 `NODE_ENV=production`，并把 `WHAT_THE_REPO_WEB_URL` 设为你自己的 HTTPS 地址。

COS、MCP、管理台和搜索都是可选功能，可以不配置。

## 启动

```sh
docker compose --env-file .secrets/runtime.env -f compose.runtime.yaml up --build -d --wait
```

编排会初始化数据库，并启动 PostgreSQL、Redis、API、分析 Worker、清理调度器和前端。前端监听 `127.0.0.1:5307`，API 和数据库不直接对外开放。

## 放到服务器上

- 自己配置 HTTPS 反向代理，可以参考这份[占位符 Nginx 模板](../infra/docker/public-edge.nginx.conf.template)。
- 数据保存在命名卷里，请自己安排并验证异机备份。
- 实例专用的端口、资源上限和网络设置，放在被忽略的 `compose.instance.yaml` 里，通过额外的 `-f` 加载。

## 多副本与可选功能

- `--scale api=2 --scale analysis-worker=2` 可以用同一份服务代码运行多个副本。清理调度器请保持单实例。
- `--profile monitoring` 需要配置你自己的指标 Token 和 Grafana 凭据。
- `--profile evolution` 需要单独的模型配置，并会给受信任的 Worker Docker 访问权限，默认不启动。

## 用文件提供密钥

如果需要用文件提供凭据、让服务文件系统只读，可以再加上 [compose.runtime-secrets.yaml](../compose.runtime-secrets.yaml)，在 `WTR_SECRET_ROOT` 下放好其中声明的密钥文件，并确保每个容器用户只能读到挂载给自己的文件。这份可选配置不会替你生成凭据。

## 验证

PR 会运行下面这些检查，都不需要维护者的账号或部署文件：

- [运行配置检查](../scripts/test-runtime-config.mjs)
- [多副本与故障切换测试](../scripts/test-runtime-compose.ps1)
- [隔离 PostgreSQL 测试](../scripts/test-postgres.mjs)

## 容量

并发设置、个人限制、分析阶段资源和旧配置迁移，见[运行容量说明](runtime-capacity.md)（英文）。示例值只是起点，没有经过容量压测。
