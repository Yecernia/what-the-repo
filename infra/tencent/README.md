# 腾讯云生产权限边界

本目录只保存需要按部署账号替换的权限策略模板，不保存 SecretId、SecretKey、STS Token 或控制台数据码。

- `cam-product-objects-policy.json` 只允许产品进程读写广州产品桶的
  `what-the-repo/production/` 前缀；它没有列举桶、修改桶配置、版本控制或跨地域复制的权限。
- `cam-postgres-backup-policy.template.json` 用于独立 WAL-G 程序身份。示例复用同一广州桶
  `your-product-data-1234567890`（替换桶名及 APPID），桶级权限只用于 WAL-G 列举备份和分片上传，正文权限只覆盖
  `postgresql/production/`；不创建上海桶或第二套产品存储。
- 两个策略必须绑定到两个不同的 CAM 子用户，并分别生成一套程序访问密钥。产品对象密钥不能读取数据库
  备份，数据库备份密钥不能读取产品对象。
- 开启版本控制、生命周期、跨地域复制或创建密钥属于云账号变更，执行前仍要取得用户对具体动作的确认。

生产服务器把两套凭证分别保存到 `/opt/what-the-repo/shared/secrets/`。普通 Docker Compose 的文件型
Secret 是只读 bind mount，不能替非 root 容器重映射 UID/GID；因此父目录必须为 root 所有的 `0700`，
其中 Secret 文件为 root 所有的 `0444`。宿主机普通用户无法穿过父目录，容器内只有显式挂载该文件的服务
可以读取。运行容器只通过 `compose.production.yaml` 获得对应的只读 Secret 文件。
