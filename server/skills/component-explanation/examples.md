# Architecture wording from verified code

These partial examples use DSH source at `d347e703908d0406b7a7ef80e3a0e594d86b2215`, inspected without executing the repository. They illustrate expression and boundaries, not a required diagram layout, fixed component IDs or evidence for another run. This reference is supplied by the runtime.

## Give the part a recognizable responsibility

`packages/core/agent-loop/src/index.ts:358–360,416–420` declares AgentLoop's service dependencies and registers the agent factory. In `agent.ts:237–254,275–282`, the loop passes a pre-step decision point before proceeding.

A name such as **Agent主循环** / **Agent loop** identifies the responsibility. A suitable partial explanation is: "组织Agent的逐步执行，并在进入下一步前经过已接入的检查。" Do not rename it a "宿主执行世界与约束层" merely to sound architectural. Check the whole supplied component membership before using this wording as a component-level summary.

`packages/client/ui-layout/src/client/AppFrame.tsx:214–215` uses drag handles for sidebars and details, while `index.ts:119–147` registers the frame. **界面布局** / **Interface layout** describes this responsibility. "提供页面框架，并支持调整侧栏和详情栏宽度。" explains the verified behavior more clearly than "Web GUI双半区". This does not characterize every Web component or dictate how many top-level layers to draw.

## Do not widen a local guarantee

The separately composed checkpoint policy at `packages/session/session-checkpoint-policy/src/index.ts:29–37,63–82` flushes a session before selected operations, with bypass conditions. A supported statement is: "检查点插件在相关模型请求和顶层工具执行前保存会话。" The explanation should retain the relevant context/bypass conditions.

This does not support a parent-layer claim that all tasks persist, all operations flush, or a crash can never repeat a side effect. When completed component explanations differ in lifecycle or persistence, preserve those differences in the parent rationale rather than overwrite them with the most reassuring summary.

A clear diagram does not require identical mechanisms, elaborate names, or a scope wrapper around every component. Keep the existing facts and explain the smallest defensible common responsibility.