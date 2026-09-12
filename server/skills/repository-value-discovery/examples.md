# Verified discovery examples

These cases were researched from public material and retained safe source at `deepseek-ai/deepseek-harness@d347e703908d0406b7a7ef80e3a0e594d86b2215`. Their Chinese titles and explanations were approved by the product owner. They are teaching material, not a new product-model run, a measured performance result, or evidence for another repository/version. When analyzing this repository, use the paths below as lookup leads: verify the current source, obtain real evidence IDs from tools, and reuse the title when the supported scope matches. For another repository, transfer the research method, not these answers or paths. Never invent IDs. The runtime supplies this file with the Skill; no filesystem tool is needed to read it.

## Official concept: 一切皆插件

**Lead:** The official release page (`https://www.deepseek.com/harness/en/`) says "Everything is a plugin"; the fixed repository's `README.zh.md:7` uses "一切皆插件".

**Question:** Does this describe the operating architecture, or merely an extensible tool list?

**Evidence checked:** `packages/bundle/base/cordis.patch.yml:27–34,471–498` composes model/session services, tools, the agent loop and a model adapter. `packages/core/agent-loop/src/index.ts:358–360,416–420` declares service dependencies and registers the agent factory. `packages/llm/llm-deepseek/src/index.ts:455–476` creates and registers an adapter; `packages/llm/llm/src/index.ts:384–400` removes owned routes on release. These independent capability paths support the central architecture claim.

**Decision:** Include the representative design and keep its official short name. A single boot/profile file would support a narrower configuration point, not this whole claim. Do not bury the central design under a list of small examples.

**Review record:** After verifying those capability paths, record `name: "Everything is a plugin"`, `source: "README.zh.md:7"`, `decision: "included"`, and `selected_title: "一切皆插件"` for Chinese output. Explain the verified registration/composition/lifecycle scope in `reason` and cite the current tool-returned evidence IDs also used in the point. If the current code no longer supports it, record the specific difference; do not select this answer merely because the example exists.

**Approved Chinese expression (content fields only):**

- `title`: 一切皆插件
- `claim`: DSH把模型接入、工具、会话管理和Agent主循环都做成插件，通过配置装配。
- `problem`: 如果这些能力被写在一起，增加或替换一种实现就容易牵动主流程。
- `implementation`: 启动配置选择插件，插件通过公共服务接口协作。例如，主循环声明所需服务并注册Agent工厂，模型插件注册适配器；释放适配器时，会撤回它拥有的路由。
- `tradeoffs`: 阅读一次请求需要追踪配置、依赖和注册过程，也要维护好接口与生命周期。插件化本身不提供安全隔离。
- `transfer_conditions`: 适合模型、工具或运行方式需要持续扩展和替换的平台；能力固定的小程序未必需要同样的组织方式。

For English output, use "Everything is a plugin" and express the same supported scope in English. Do not add "every file is a plugin", automatic compatibility or security guarantees.

## Official mixed-language names (current-source follow-up)

The following names were checked against `deepseek-ai/deepseek-harness@c291e7961a515f6d7af9304e7fd1d257929aef26`, not assumed from the older examples above.

- `docs/architecture.zh.md:129` names the concept **能力 seam**; the English counterpart at `docs/architecture.md:125` is **Capability seams**. For Chinese readers, after verifying the interface/provider/consumer roles in current code, use **能力 seam** exactly. Do not rewrite it as “能力接缝” or “接口与实现分离” when this official Chinese name exists. Explain the three roles in ordinary Chinese in the body.
- `packages/guard/README.zh.md:6` calls the family **循环卫生 guard 家族**; the English counterpart calls it **loop-hygiene guard family**. The docs and implementation describe repeat-call reminders and opt-in per-tool timeout handling. Retain the mixed-language official name for Chinese output instead of translating guard to “守卫”. Explain the reminder and cooperative timeout, including their limits, in the body.
- When only an English name exists, translate its actual meaning naturally rather than copying this example's Chinese names. Conversely, a Chinese-only official concept needs a natural English translation for English readers. Do not attribute the translated wording to an official target-language page that you have not found.

These are naming examples, not mandatory value points. Keep the same evidence and scope checks as for “一切皆插件”; do not add a point merely to reproduce this list.

## Community framing: 策略与机制分离

**Lead:** Locsic's original analysis (`https://locsic.com/thinking/deepseek-harness-architecture-analysis/`) frames the lifecycle as policy/mechanism separation. Its older source baseline and incomplete package access make it a lead, not proof. Official package documentation also discusses policy/storage separation; the categories overlap.

**Evidence checked:** `packages/core/agent-loop/src/agent.ts:237–254,275–282` invokes the pre-step decision chain. `packages/llm/llm/src/index.ts:1097–1106` wraps adapter execution in `llm/stream`. The independently composed `packages/session/session-checkpoint-policy/src/index.ts:29–37,63–82` waits for session flush before continuing selected model/tool/pre-step paths; the base configuration at 394–396 includes it.

**Decision and expression:**

- Title: **策略与机制分离** / **Separation of policy and mechanism**.
- Claim: 执行流程负责推进工作，独立的策略插件决定某个关口需要先满足什么条件。
- Mechanism: 检查点插件接入模型调用、顶层工具执行等入口，先保存会话，再让后续流程继续；规则实现不用挤进同一段执行代码。
- Limit: 调试时需要追踪实际装配的监听器及其顺序。部分没有会话上下文的请求和嵌套工具会放行，不能说所有操作都先落盘，也不能推导崩溃后副作用恰好一次。

This teaches rule interception and continuation; the previous case teaches capability composition. They may coexist when these are useful distinct lessons, or be combined when their explanations repeat. Do not create a second "microkernel" point that merely renames the same plugin architecture. Do not inherit an article's unrelated claims about author strategy or financial-grade isolation.

## Code discovery: 拖拽按帧更新

**Lead and check:** Inspecting `packages/client/ui-layout/src/client/AppFrame.tsx` revealed a concrete high-frequency UI mechanism. Targeted searches for the core file and drag throttling found no direct outside analysis in this investigation; third-party pet/mobile plugins were different implementations. This does not establish that nobody has written about it.

**Evidence checked:** At 44–75, `DragHandle` stores the latest coordinates and keeps at most one animation-frame callback pending. Later moves update the coordinates; the callback reports the latest displacement. Normal pointer release cancels a pending callback and reports the final observed displacement. At 214–215, the sidebar/details controls actually use it. `packages/client/ui-layout/src/client/index.ts:119–147` registers AppFrame, and `packages/bundle/web-app/cordis.patch.yml:188–189` composes the layout plugin.

**Decision and expression:**

- Title: **拖拽按帧更新** / **Frame-paced drag updates**.
- Claim: 拖动面板时先记住最新位置，下一帧再调整布局，松手时补上最后的位置。
- Why it matters: 一帧之间的多次鼠标移动不必逐次调整布局，适合只关心当前位置的交互。
- Limit: 中间位置不会逐次通知，拖动中的更新通常等到下一帧；需要完整轨迹记录的场景不能照搬。没有帧率测量，不能宣称实测提速或保证永不卡顿。

**Tool-use illustration, not a recorded Trace:** First choose the owning component ID from the current catalog. To find members, use `get_repository_component` with that ID and `member_path_prefix`. For a known path with an unknown location, use `get_repository_file_outline` with `query: "DragHandle"`; if the symbol is absent, inspect the relevant source rather than conclude it does not exist. Once the location is known, a source request has this form:

```json
{"component_id":"<replace with the current catalog ID>","path":"packages/client/ui-layout/src/client/AppFrame.tsx","offset":44,"limit":32}
```

The returned evidence IDs belong to the current run. Read the actual callers/registration when needed to establish usage. An answer that contains the technique but has no established active caller is not equivalent to this case.

## Code discovery corroborated by docs: 请求合并与独立取消

**Evidence checked:** `packages/llm/llm-deepseek/src/adapter.ts:584–603` calls `ensureUploaded`. `file-store.ts:142–175` shares an in-flight upload for the same FileStore instance, connection scope and image version. At 59–91, each waiter can cancel independently; the underlying unsettled upload is aborted only after the last waiter leaves. `upload-index.ts:45–51` distinguishes endpoint/credential scopes. The package README also documents this mechanism, discovered after the code investigation.

**Decision and expression:**

- Title: **请求合并与独立取消** / **Request coalescing with independent cancellation**.
- Claim: 多个并发请求可以共用一次图片上传；一个请求取消时，其他请求仍能继续等待。
- Why it matters: 减少重复工作，同时避免把所有调用者绑到同一个取消信号。适合多个调用者共享同一项昂贵操作的场景。
- Limit: 需要管理等待者和取消归属。在途合并有实例、连接和图片版本边界；过期可能重新上传，多进程也不靠同一张内存表合并。不能写成一张图片永远只上传一次。

The nearby tests contain assertions for coalescing and cancellation, but this investigation only read them. Do not report them as executed or treat them as a replacement for the implementation and caller.

## A real rejected candidate

`packages/client/store/src/index.ts:72–88` contains `rafBatch`, but the store defaults to synchronous updates. Inspection of `defineStore` at 217–233 and product call-site searches did not find an active opt-in to its frame mode. Therefore reject the claim that DSH chat updates already benefit from that helper. This is different code from the verified DragHandle above; their evidence cannot be interchanged.

A useful negative example ends with a factual reason to exclude or narrow the claim. It does not require an extra model rewrite, a performance experiment, or a universal prohibition on discussing optional capabilities.
