# 第三方声明

**简体中文** · [English](THIRD_PARTY_NOTICES.md)

[返回产品介绍](README.md)

根目录的 [LICENSE](LICENSE) 适用于 what-the-repo 自有代码。第三方代码、字体、标志、依赖包和其他材料保留各自的版权与许可，不会因为被纳入本仓库就自动改用本项目的许可。

本页是项目第三方声明的中文版，便于阅读；各项上游 LICENSE/NOTICE 保留原文，本页不替代或修改其中的条款。

本仓库包含在线 Web 产品的源码。本机启动脚本用于开发和测试；本次源码发布不包含单独的免登录桌面版或本地产品。

## 代码与设计来源

| 项目 | 在 what-the-repo 中的用途 | 许可与声明 |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi/tree/v0.84.1) | 直接使用其 Agent/AI SDK，并用于独立的 Evolution Coding Agent。`server/src/agent/source-read.ts` 改编了 Pi 的有界读取与截断行为，增加本项目的安全路径、UTF-8 整行分页和结构化续读机制。 | [MIT，Mario Zechner](licenses/upstream/pi.txt)。npm 清单也记录了间接依赖的 Pi 包及其准确版本。 |
| [CodeBoarding](https://github.com/CodeBoarding/CodeBoarding/tree/164d75247ab933978790a9b4a42f4192ca54f484) | `server/src/analysis/` 下确定性分析的代码与参考来源，尤其包括语言适配器、LSP/Tree-sitter 事实和图构建。原 Python 实现已替换成本项目的 TypeScript 运行时；快照契约、安全获取、存储与编排由本项目实现。上游生成的对比结果仅作为范围受限的测试样本保留。 | [MIT，CodeBoarding](licenses/upstream/codeboarding.txt)。基于已记录的代码来源关系，审慎保留其声明，并非仅作致谢。 |
| [Understand Anything](https://github.com/Egonex-AI/Understand-Anything/tree/fe8c5bc591716aafd79b4765549328f08ef5a52e) | 用于参考分批语义分析、Worker 职责、架构视图和学习导览。产品 Skill、契约及运行时由本仓库维护。历史 UA 对比结果保留在测试样本中；本项目不打包上游插件，也不依赖其运行。 | [MIT，Yuxiang Lin 与 Infinite Universe, Inc.](licenses/upstream/understand-anything.txt)。 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 作为具名研究、评测对象，以及 `server/skills/*/examples.md` 和 `server/src/evals/architecture-quality-cases.ts` 中引用的教学示例；不是产品的运行时依赖。示例分别注明其提交与源码路径。 | [上游 MIT 声明](licenses/upstream/deepseek-harness.txt)。引用的第三方文章在使用处注明来源。 |

## 依赖与视觉素材

- [直接依赖](licenses/DIRECT_DEPENDENCIES.zh-CN.md)：包的用途、所属模块、锁定的准确版本和声明的许可。
- [完整 npm 清单](licenses/NPM_DEPENDENCIES.zh-CN.md)及[机器可读清单](licenses/npm-inventory.json)：运行时、开发、可选及间接依赖，附收集到的 LICENSE/NOTICE 原文。
- [视觉素材](licenses/ASSETS.zh-CN.md)及[逐文件证据](licenses/assets.json)：Devicon、IconPark、LobeHub Icons、SVGL、Simple Icons、Jason Handwriting，以及 Sketchy Icons 继承的 Lucide/Feather 来源。
- [分发说明](licenses/DISTRIBUTION.zh-CN.md)：仅有许可声明的包例外、构建工具许可、容器与运行时边界，以及再分发要求。

## 研究致谢（不属于打包依赖）

下列项目帮助我们评估设计。列出它们不表示存在关联、背书、共同署名，也不表示其代码获得了本项目 MIT 许可的授权。

| 参考项目 | 研究内容与当前边界 |
| --- | --- |
| [Aider](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c) | 仓库地图、有界上下文、相关性、缓存和有限重试。未打包 Aider 的包或源码。如果未来引入其代码，需要遵守 Apache-2.0。 |
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus/tree/dea396a13ca78e3301d6b95b1ab50374a6a34758) | 派生的社区与流程、确定性遍历和有界查询工具。未引入其采用 PolyForm Noncommercial 许可的实现或图数据库技术栈。 |
| [React Flow Smart Edge](https://github.com/tisoap/react-flow-smart-edge/tree/0b73a4056e0da894513a7bc29e89ac85f40f0f99) | 曾评估连线路由，之后已移除。当前图连线使用 React Flow 的贝塞尔路径；不再保留 Smart Edge 依赖或其路由实现。 |
| [GraphRAG](https://github.com/microsoft/graphrag/tree/f40e9a26ce62ba0b3fef8837d24aafdcc6e6c704) 与 [Guardrails](https://github.com/guardrails-ai/guardrails/tree/06d0ff2c5f9bcb493d976b76f885e37e41ce845d) | 只读研究紧凑标识符、上下文表示和结构校验。两者都不是运行时依赖。 |
| [React Bits](https://github.com/DavidHDev/react-bits) | 用于早期视觉效果实验。曾引入的动画组件已移除；当前文字样式由本项目的小段 CSS 实现维护。React Bits 的 MIT + Commons Clause 条款不等同于单纯的 MIT 授权，也不适用于本项目整体。不要将其组件当作仅受 MIT 约束的代码重新引入。 |
| [Tavily Skills](https://github.com/tavily-ai/skills)、[Slonik](https://github.com/gajus/slonik)、[DDGS](https://github.com/deedy5/ddgs)、[Promptfoo](https://www.promptfoo.dev/)、LangGraph 与 Pydantic AI 文档 | 用于参考搜索、SQL 批处理、搜索服务行为、评测、依赖顺序和重试。本项目不打包这些库或 Skill。 |
| 模型厂商文档与 SDK 示例，包括 [Xiaomi MiMo](https://github.com/XiaomiMiMo/awesome-mimo-agent)、[Z.ai](https://github.com/zai-org/z-ai-sdk-python) 和 [Qwen Code](https://github.com/QwenLM/qwen-code) | 用于 API 兼容性与故障排查参考，没有额外复制这些运行时。 |

研究用克隆、分析下载、内部协作笔记和开发历史不包含在本次源码快照中。一个被产品分析的仓库，不会因此自动成为产品依赖。

## 维护

修改依赖描述文件、锁文件或随产品分发的视觉素材后，运行 `node scripts/check-license-inventory.mjs`。引入或修改第三方材料时，更新清单并保留对应的准确上游声明。检查覆盖已记录的清单完整性与文件一致性，不构成法律判定，也不会扫描未记录的源码衍生关系。
