<div align="center">

<h1>what-the-repo</h1>

<p><strong>发现一个开源项目值得学的地方，沿着代码真正弄懂它。</strong></p>
<p>面向公开 GitHub 仓库的 AI 研学伙伴。</p>

<p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

<p>
  <a href="https://bottlecapduel.com"><img src="https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-7C5CBF?style=flat-square" alt="在线体验 what-the-repo"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/MIT%20%E8%AE%B8%E5%8F%AF%E8%AF%81-D4A72C?style=flat-square" alt="查看 MIT 许可证"></a>
  <a href="https://github.com/Yecernia/what-the-repo"><img src="https://img.shields.io/badge/%E6%9F%A5%E7%9C%8B%E6%BA%90%E7%A0%81-39815A?style=flat-square" alt="查看源码"></a>
  <a href="CONTRIBUTING.zh-CN.md"><img src="https://img.shields.io/badge/%E5%8F%82%E4%B8%8E%E8%B4%A1%E7%8C%AE-536878?style=flat-square" alt="参与贡献"></a>
</p>

<p><img src=".github/assets/product-hero.svg" width="600" alt="what-the-repo：从好奇开始。树下长椅上的人用电脑探索仓库。"></p>

<p><a href="https://bottlecapduel.com"><strong>打开 what-the-repo ↗</strong></a> · <a href="https://github.com/Yecernia/what-the-repo/issues">反馈与建议</a></p>

</div>

## 遇到一个好项目，然后呢？

你可能知道它很厉害，却不知道该先读哪个文件、哪些设计值得学，或者为什么要这样实现。

**what-the-repo 帮你把这份好奇变成有方向的学习。** 提供一个公开 GitHub 仓库，先看清主要结构，再找到感兴趣的设计与实现，结合源码追问、理解，并尝试用自己的话解释。

## 从“想学”到“弄懂”

### 定一个目标，沿着路线一步步学

把感兴趣的主题拆成可以逐步掌握的小目标。确认路线后，结合代码听讲解、追问，再通过理解检验检查自己是否掌握；学习进度也会保留下来。

![what-the-repo 中真实的 DSH 学习路线、分步讲解和学习进度。](.github/assets/dsh-learning.jpg)

*实际页面示例：研学 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 运行时。*

### 读讲解，也能顺着证据看实现

点击引用文件查看解释背后的代码；需要整体脉络时，再通过架构图探索组件职责和它们之间的关系。

![点选 DSH 会话任务清单组件，突出相关连线并淡化其他节点。](.github/assets/dsh-component.jpg)

## 可以用它做什么

| 你想弄明白的事 | what-the-repo 怎么帮你 |
| --- | --- |
| **有哪些值得我学习的东西？** | 从架构设计、关键实现和工程取舍中发现值得深入的主题，结合仓库内容说明原因。 |
| **这段解释有代码依据吗？** | 顺着文件、符号和行号查看源码，核对解释中的结论，也区分事实、推断和待确认内容。 |
| **我想系统学会这一部分。** | 确认学习目标后生成分步路线，围绕小主题讲解、提问和检查理解；也可以随时自由追问。 |
| **这个项目是怎么组织起来的？** | 浏览架构图、组件及其关系，把入口、职责和主要流程连起来。 |
| **下次还能接着学吗？** | 保存项目、对话和学习状态，用可控制的记忆摘要帮助延续学习。 |

你可以这样问：

> “这个仓库最值得我学习的三个设计是什么？请结合代码说明。”
>
> “从请求入口开始，带我走一遍主要调用链。”
>
> “我想理解这里的任务恢复机制，先帮我制定一条学习路线。”

## 在线开始

1. 打开 **[bottlecapduel.com](https://bottlecapduel.com)**，通过 GitHub 登录或使用访客入口。
2. 输入一个**公开 GitHub 仓库链接**，等待分析完成。
3. 浏览项目视图，选择感兴趣的内容提问，或开始一段引导式学习。

界面和研学内容支持中文、英文。首次分析需要时间，耗时会随仓库规模和模型响应变化。

## 这个仓库包含什么

这里开源的是 **what-the-repo 在线 Web 产品的源码**，包括前端、后端、仓库分析、Agent、测试与服务实现。直接体验产品不需要下载本仓库，也不需要安装 Docker。

如果你想阅读实现、参与开发或研究部署方式，请看 [贡献指南](CONTRIBUTING.zh-CN.md)。目前没有单独发布免登录的本地版或桌面客户端。

## 反馈与贡献

发现解释有误、证据缺失或操作不顺手，欢迎 [提交 Issue](https://github.com/Yecernia/what-the-repo/issues)。附上公开仓库链接、复现步骤和预期结果，会更容易定位问题；请不要附带密钥或私人数据。

代码和文档改进欢迎通过 PR 提交，具体流程见 [贡献指南](CONTRIBUTING.zh-CN.md)。

参与交流请遵守[社区行为规范](CODE_OF_CONDUCT.zh-CN.md)；报告漏洞请先阅读[安全报告说明](SECURITY.zh-CN.md)。

## 许可与致谢

项目自有代码采用 [MIT 许可证](LICENSE)。第三方代码、图标和字体保留各自的许可条款。

项目使用 **Pi SDK**，并在研究与实现过程中参考了 **CodeBoarding、Understand Anything** 等项目。具体采用范围、其他参考来源和版权声明见 [第三方声明](THIRD_PARTY_NOTICES.md)。
