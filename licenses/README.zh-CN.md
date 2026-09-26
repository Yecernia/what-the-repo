# 许可记录维护

**简体中文** · [English](README.md)

这个目录保存第三方 LICENSE/NOTICE 原文，以及依赖和素材清单，概览见[第三方声明](../THIRD_PARTY_NOTICES.md)。`npm/` 下的文件按内容寻址，许可文本相同的包共用一份，文件名是 SHA-256 哈希，不是 npm 包名。包与文本的对应关系记录在 [npm-inventory.json](npm-inventory.json)。

修改依赖时：

1. 使用全部四个锁文件中解析出的版本，包括可选、平台相关和开发依赖。核对确切的包清单，以及包内附带的 LICENSE、NOTICE 或版权头。锁文件缺少许可信息时，查看包内文件和上游仓库。
2. 原样保留上游文本。包内没有附带时，记录对应上游声明的获取位置。版权信息以上游文本为准。信息不完整的情况按 [DISTRIBUTION.md](DISTRIBUTION.md) 的说明明确标记。
3. 在 `npm-inventory.json` 中更新包的出现位置、许可声明、依据和清单哈希，并同步更新两份供人阅读的依赖表。清单哈希按 UTF-8 文本计算，CRLF 统一为 LF；声明和素材哈希按存储的原始字节计算，`.gitattributes` 会保留声明和 SVG 文件的原始字节。
4. 新增或修改会随产品分发的视觉素材时，在 `assets.json` 中记录来源、版权与许可、修改说明和校验和。素材声明要让浏览器用户能够看到，包括图标几何形状间接引用的声明。
5. 在仓库根目录先运行 `node scripts/generate-browser-notices.mjs`，再运行 `node scripts/check-license-inventory.mjs`。

默认检查会核对清单记录、文件哈希和浏览器中的声明。加上 `--distribution` 时，缺失或不完整的许可文本也会导致检查失败。发布镜像和安装包时，还需要列出其中的系统包和原生依赖，见[分发说明](DISTRIBUTION.md)。

[upstream-sources.json](upstream-sources.json) 记录收集许可时使用的上游版本；[assets.json](assets.json) 记录各个素材的来源和匹配信息。

更新依赖表时，请保留包标识、版本、SPDX 标识和上游声明原文。
