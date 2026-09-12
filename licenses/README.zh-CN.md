# 许可记录维护

**简体中文** · [English](README.md)

先阅读[第三方声明](../THIRD_PARTY_NOTICES.zh-CN.md)。本目录单独保存上游 LICENSE/NOTICE 原文，与项目根目录的 MIT 许可分开。中文说明不替代或修改许可原文。

`npm/` 中按内容摘要命名的文件，由具有相同声明文本的依赖包共用。文件名是 SHA-256 摘要，不是 npm 包名；包与声明文本的对应关系见 [npm-inventory.json](npm-inventory.json)。

依赖变化时：

1. 使用全部四份锁文件中实际解析出的版本，包括可选、平台相关及开发依赖。检查准确版本的包描述文件，以及内附的 LICENSE、NOTICE 和版权文件头。锁文件缺少许可字段，不等于依赖包没有许可。
2. 原样保留上游文本。如果包内缺失，记录对应上游声明的获取位置。不要自行根据包作者姓名编造版权声明。材料不完整的情况须按[分发说明](DISTRIBUTION.zh-CN.md)明确标记。
3. 更新 `npm-inventory.json` 中的依赖出现位置、许可声明、证据和包描述文件摘要，同时更新[直接依赖表](DIRECT_DEPENDENCIES.zh-CN.md)与[完整依赖表](NPM_DEPENDENCIES.zh-CN.md)。包描述文件摘要按 UTF-8 文本计算，并将 CRLF 统一成 LF；声明与素材摘要按存储的原始字节计算。`.gitattributes` 用于保留声明和 SVG 的字节内容。
4. 新增或修改随产品分发的视觉素材时，在 `assets.json` 中记录来源、版权与许可、修改说明和校验摘要。确保浏览器用户也能获取素材声明，包括间接继承的图标几何形状声明。
5. 在仓库根目录先运行 `node scripts/generate-browser-notices.mjs`，再运行 `node scripts/check-license-inventory.mjs`。

默认 CI 检查验证已记录的源码清单。添加 `--distribution` 后，还会拒绝仅有许可声明或声明不完整的包；即便该选项检查通过，也不能替代对实际镜像或安装包中操作系统及原生依赖的检查。普通 CI 的这项检查不下载或执行上游研究项目、不联系模型服务，也不需要密钥。

素材所用的上游许可快照及其修订版本记录在 [upstream-sources.json](upstream-sources.json)。许可快照的版本不自动等于每个相关素材最初引入时的版本；[assets.json](assets.json) 的逐文件证据对此作了区分。

维护说明文档时同步中英文版本。更新中文依赖表时，保持包标识、版本号、SPDX 许可标识和上游声明原文一致。
