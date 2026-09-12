# Architecture wording from verified code

These partial examples use DSH source at `d347e703908d0406b7a7ef80e3a0e594d86b2215`, inspected without executing the repository. They illustrate expression and boundaries, not a required diagram layout, fixed component IDs or evidence for another run. This reference is supplied by the runtime.

## A shared plugin interface does not imply one shared purpose

The DeepSeek adapter registers model access in `packages/llm/llm-deepseek/src/index.ts:455–476`; the UI layout registers a page frame. Both are plugins, but one handles model access and the other a user interface. "Both are plugins" alone is not a reason to put these components in one responsibility scope. Use the full catalog to decide their actual ownership and peers; keep an independent component direct when no suitable peer exists.

Conversely, a layer can contain different mechanisms contributing to the same task. A parent explanation should state that common task and attribute specific behavior to the right member, not require all members to work identically.

## Do not widen a local guarantee

The separately composed checkpoint policy at `packages/session/session-checkpoint-policy/src/index.ts:29–37,63–82` flushes a session before selected operations, with bypass conditions. A supported statement is: "检查点插件在相关模型请求和顶层工具执行前保存会话。" The explanation should retain the relevant context/bypass conditions.

This does not support a parent-layer claim that all tasks persist, all operations flush, or a crash can never repeat a side effect. When completed component explanations differ in lifecycle or persistence, preserve those differences in the parent rationale rather than overwrite them with the most reassuring summary.

A clear diagram does not require identical mechanisms, elaborate names, or a scope wrapper around every component. Keep the existing facts and explain the smallest defensible common responsibility.