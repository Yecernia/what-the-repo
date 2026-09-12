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

固定产品 Eval 检查：源码不变、文件集合、符号锚点、导入/继承召回、调用 precision/recall、组件
证据和学习路线。它不会执行样例代码，也不会把确定性图结果冒充真实 Provider 或主观教学质量。

主对话 Eval 把 `eval/cases/primary-conversation.json` 的 15 项最终 Pi 行为契约绑定到实际 Node test。

完整质量门：

```powershell
npm run quality
npm run quality:all -- --allow-skips
```

CodeBoarding 和 Understand Anything 的旧成对比较报告属于研究历史；当前产品真值以
`eval/cases/python-edge-cases.json` 和 TypeScript 产品 Eval 为准，不在质量门里重新运行上游模型。
