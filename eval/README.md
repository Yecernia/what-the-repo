# 固定评测材料

`eval/` 保存固定输入、真值和对照样例；可执行产品 Eval 已迁到 `server/src/evals/`，不依赖
Python 运行时。

## 当前固定样例

- `fixtures/python-edge-cases/source/`：10 文件多语法 Python 被分析样例。
- `cases/python-edge-cases.json`：文件、符号、导入、继承和调用真值。
- `fixtures/language-truth/`：九语言 LSP 固定真值输入；实际内容哈希由 TypeScript 测试锁定。
- `fixtures/python-edge-cases/codeboarding/` 与 `understand-anything/`：固定上游研究产物。
- `fixtures/python-edge-cases/product-legacy/`：迁移前产品图谱基线，仅用于历史对照。
- `runs/`：被 Git 忽略的内部研究产物，不随源码发布。新的执行报告写入被忽略的 `out/`。

## 运行 TypeScript 产品 Eval

```powershell
Set-Location server
npm run eval:fixture -- --output-dir ../out/product-eval
npm run eval:conversation -- --output-dir ../out/conversation-eval
```

固定产品 Eval 检查：源码不变、文件集合、符号锚点、导入/继承召回、组件证据与层级子节点，以及静态阶段
不提前生成价值点或学习路线。`tree_sitter_local_calls` 固定了样例中 6 条可直接识别的本地调用候选，
包含模块入口调用，要求 precision/recall 均为 100%。这些是降级候选，不代表编译器或 LSP 已验证的绑定。

原有 58 条完整调用真值继续保留，完整调用 precision/recall 和缺失项仍输出到报告；完整 recall
不作为这个纯 Tree-sitter 阶段的门禁。跨文件、对象方法和回调绑定需要相应语言分析能力，
不能通过同名猜测来补齐。源码不会被执行，报告不代表完整调用分析或真实 Provider 的教学质量通过。

主对话 Eval 把 `eval/cases/primary-conversation.json` 的 20 项最终 Pi 行为契约绑定到实际 Node test，
包括学习确认、路线与进度的写入边界。未验证的回答连同引用提示保留在会话中，不提升为可信长期记忆；
评测仍要求所有绑定测试存在并通过。

完整质量门：

```powershell
npm run quality
npm run quality:all -- --allow-skips
```

CodeBoarding 和 Understand Anything 的旧成对比较报告属于研究历史；当前产品真值以
`eval/cases/python-edge-cases.json` 和 TypeScript 产品 Eval 为准，不在质量门里重新运行上游模型。
