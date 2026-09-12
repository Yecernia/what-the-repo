# 分发与许可边界

**简体中文** · [English](DISTRIBUTION.md)

[第三方声明](../THIRD_PARTY_NOTICES.zh-CN.md) · [许可记录维护](README.zh-CN.md)

本页是项目分发说明的中文版。涉及的上游许可与声明均保留原文，中文说明不替代或修改其条款。

## 清单覆盖范围

仓库中的清单覆盖四份锁文件里的 846 个不同 npm 包名与版本组合，共 1,028 个锁文件位置，包括可选与开发依赖。源码快照不包含 `node_modules`、研究用克隆、语言服务器安装目录、容器镜像或原生二进制文件。

根目录 MIT 许可不替代上游条款。再分发副本时，应保留收集的声明。README 中的致谢不能代替相关许可要求的版权声明或完整许可文本。

## 包声明的例外情况

全部 846 个包都已从锁文件、已安装包的描述文件或准确版本的 npm 元数据核实许可声明。其中 833 个包已收集上游许可或声明；以下 13 条记录明确保留 `metadata-only-or-partial`（仅元数据或部分声明）标记：

| 包 | 证据与限制 |
| --- | --- |
| `@mariozechner/clipboard@0.3.9` 及同为 `0.3.9` 的十个平台包 | 发布元数据声明 MIT。已检查的包与上游源码树没有提供完整 LICENSE 文件。该分支注明了 CrossCopy/clipboard 和 clipboard-rs 的来源；原生 Rust 依赖还需要单独进行二进制层面的清单核对。本项目没有编造替代版权行。 |
| `@napi-rs/lzma-linux-x64-gnu@1.5.1` | 发布元数据声明 MIT，但未找到该包完整的上游许可文本。重新打包其二进制文件前，需要检查原生库依赖。 |
| `stackback@0.0.2` | 元数据声明 MIT，但没有单独的完整 MIT 声明。`formatstack.js` 带有 V8 的 BSD-3-Clause 版权与许可文件头，已收录到声明中。内嵌的这部分代码按 BSD-3-Clause 对待，不能仅按 MIT 处理。该包属于开发依赖。 |

这些是明确记录的再分发待办，没有将缺失材料默认为完整。本次源码发布仅声明 npm 依赖，并未包含其二进制文件。发布预装镜像、可执行文件、桌面安装包或打包 SDK 前，需要解决适用的例外情况，并核对**实际分发产物**，包括其内嵌的原生依赖。只要这些例外记录仍然存在，`node scripts/check-license-inventory.mjs --distribution` 就会按设计检查失败。

## 需要特别注意的许可

- `lightningcss@1.33.0` 及其十一个平台包声明 MPL-2.0，属于 Web 开发与构建依赖。不要将其文件改称 MIT。如果分发受其许可约束的可执行文件或修改后的相关文件，应满足 MPL 对这些文件的源码可获取性要求。使用某个工具构建 Web 素材，本身不会使所有生成的应用代码都适用该工具的许可。详见 [Mozilla MPL 常见问题](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)及收集的包许可。
- `caniuse-lite@1.0.30001809` 包含 CC-BY-4.0 下的浏览器支持数据。再分发该数据集时，应注明 caniuse/caniuse-lite 贡献者、链接到 [caniuse-lite](https://github.com/browserslist/caniuse-lite)，并保留其[许可](https://creativecommons.org/licenses/by/4.0/)。本次源码快照声明该未修改的依赖，不复制或修改数据集。
- `json-schema@0.4.0` 提供 AFL-2.1 **或** BSD-3-Clause 两种选择。本项目选择 BSD-3-Clause，原始双许可文本仍予保留。
- Jason Handwriting 仍适用 SIL OFL 1.1。完整字体从 TTF 到 WOFF2 的转换，以及由字体生成的品牌字标，记录在[视觉素材说明](ASSETS.zh-CN.md)中。系统字体回退仅引用用户设备上的字体，并非复制字体文件。
- Apache-2.0 依赖保留完整 LICENSE 和上游提供的 NOTICE；未来复制或修改源码时，需附上修改说明。
- 品牌标志仍受其所有者的商标权约束。本项目的 MIT 许可不允许暗示获得品牌背书或声称拥有这些标志。

## 容器与外部进程

本仓库发布构建与配置方案，不发布以下上游镜像或已安装程序的副本。它们的许可需要在 npm 清单之外单独考虑：

| 组件 | 用途与许可边界 |
| --- | --- |
| Node.js、Debian/Alpine、Nginx、PostgreSQL、tini 与 Docker CLI | 外部镜像、操作系统或工具依赖。发布镜像时，应保留其分发的版权文件与许可清单；npm 许可输出不覆盖操作系统包。 |
| Redis 7.4（`redis:7.4-alpine`） | 外部服务镜像。该版本系列使用 **RSALv2 或 SSPLv1**，不是早期的 BSD 许可。其条款不会被 what-the-repo 的 MIT 替代。详见 [Redis 按版本区分的许可表](https://redis.io/legal/licenses/)。本轮许可整理没有替换版本或基础设施。 |
| Grafana（`grafana/grafana:13.1.0`） | 可选的外部监控镜像。Grafana OSS 使用 AGPLv3；插件和镜像内容可能适用其他条款。详见 [Grafana 许可](https://grafana.com/licensing/)。 |
| Prometheus、Alertmanager 与 k3s/k3d | 外部监控与集群工具，上游项目使用 Apache-2.0。再分发前需检查准确的镜像内容。 |
| WAL-G `v3.0.9` | PostgreSQL Dockerfile 会下载其二进制文件。需保留 [WAL-G 版权声明](upstream/wal-g.txt)及 [Apache-2.0](upstream/Apache-2.0.txt)。发布该镜像前，还需核对编译进二进制文件的 Go 依赖和操作系统包。 |
| 语言服务器 | 配置使用的外部可执行程序，不随本源码仓库打包。各实现与安装版本有各自的条款。 |
| OAuth、模型厂商、搜索 API 与对象存储 | 外部服务，受各自服务条款约束。源码发布不包含其凭据。 |

本清单不表示容器镜像、原生包或未来桌面版的分发产物已通过完整的再分发审查。
