# 第三方声明

**简体中文** · [English](THIRD_PARTY_NOTICES.md)

[返回产品介绍](README.md)

what-the-repo 自有代码采用 [MIT 许可证](LICENSE)。使用的第三方代码、字体、图标和依赖包保留各自的许可；原文见下方链接。

## 代码与素材来源

| 项目 | 在 what-the-repo 中的用途 | 许可与声明 |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi/tree/v0.84.1) | 使用 Agent/AI SDK 运行对话 Agent 和 Evolution Coding Agent。源码读取工具改编自 Pi 的读取与截断实现，增加路径校验、UTF-8 整行分页和续读信息。 | [MIT，Mario Zechner](licenses/upstream/pi.txt)。各 Pi 包的版本见 npm 清单。 |
| [CodeBoarding](https://github.com/CodeBoarding/CodeBoarding/tree/164d75247ab933978790a9b4a42f4192ca54f484) | 部分仓库分析实现参考并改编自 CodeBoarding，包括语言适配、LSP/Tree-sitter 分析和图构建，使用 TypeScript 实现。评测中也保留了上游生成的对比样本。 | [MIT，CodeBoarding](licenses/upstream/codeboarding.txt)。 |
| [Understand Anything](https://github.com/Egonex-AI/Understand-Anything/tree/fe8c5bc591716aafd79b4765549328f08ef5a52e) | 分批语义分析、Worker 分工、架构视图和学习导览参考了 UA 的设计，并结合本项目的在线工作流做了调整。评测中保留了部分对比样本。 | [MIT，Yuxiang Lin 与 Infinite Universe, Inc.](licenses/upstream/understand-anything.txt)。 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 用于教学示例、分析评测和 README 产品截图。源码示例注明了提交与文件位置。 | [MIT](licenses/upstream/deepseek-harness.txt)。 |

## 依赖与视觉素材

- [直接依赖](licenses/DIRECT_DEPENDENCIES.zh-CN.md)：所属模块、用途、版本和许可。
- [完整 npm 清单](licenses/NPM_DEPENDENCIES.zh-CN.md)与[机器可读清单](licenses/npm-inventory.json)：全部依赖及其 LICENSE/NOTICE。
- [视觉素材](licenses/ASSETS.zh-CN.md)与[素材清单](licenses/assets.json)：图标、字体和插画的来源、修改记录及文件摘要。
- [分发说明](licenses/DISTRIBUTION.zh-CN.md)：许可材料缺口，以及打包镜像或安装包时需要处理的事项。

## 研究致谢

以下项目的思路用在了当前实现中，感谢它们公开分享设计与经验。

| 参考项目 | 采用的思路 |
| --- | --- |
| [Aider](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c) | 按相关性和上下文预算组织仓库信息，复用分析缓存，并按错误类型限制重试。 |
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus/tree/dea396a13ca78e3301d6b95b1ab50374a6a34758) | 从事实图派生分组与流程，按稳定顺序遍历，并为查询工具设置输出上限和分页。 |
| [React Bits](https://github.com/DavidHDev/react-bits) | 思考摘要的流光文字效果参考其 Shiny Text，调整了配色和动画参数。 |
| [Tavily Skills](https://github.com/tavily-ai/skills) | 使用短查询、围绕具体问题补充搜索，按需获取正文，并核实来源与项目身份。 |
| [Slonik](https://github.com/gajus/slonik) | 参考批量写入的设计，在 PostgreSQL 中通过 JSON 记录集分批写入分析数据。 |
| [Promptfoo](https://www.promptfoo.dev/) | 用固定案例和分类断言组织评测，分别检查结构、内容质量与耗时。 |

## 维护

修改依赖或素材时，同步更新清单与对应的许可原文，再运行 `node scripts/check-license-inventory.mjs`。操作步骤见[许可记录维护](licenses/README.zh-CN.md)。
