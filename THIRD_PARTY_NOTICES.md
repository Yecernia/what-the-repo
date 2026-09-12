# Third-party notices

The root [LICENSE](LICENSE) applies to original what-the-repo code. Third-party
code, fonts, logos, dependency packages and other materials retain their own
copyrights and licenses. They are not relicensed solely by being included here.

This repository contains the source of the hosted Web product. Local launch
scripts support development and testing. A standalone, login-free desktop/local
product is not part of this source release.

## Code and design provenance

| Project | Use in what-the-repo | License / notice |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi/tree/v0.84.1) | Direct Agent/AI SDK dependencies and the separate Evolution Coding Agent. `server/src/agent/source-read.ts` adapts Pi's bounded read/truncation behavior with project-specific safe paths, UTF-8 whole-line paging and structured continuation. | [MIT, Mario Zechner](licenses/upstream/pi.txt). The npm inventory also includes transitive Pi packages and their exact versions. |
| [CodeBoarding](https://github.com/CodeBoarding/CodeBoarding/tree/164d75247ab933978790a9b4a42f4192ca54f484) | Source/reference lineage for deterministic analysis under `server/src/analysis/`, particularly language adapters, LSP/Tree-sitter facts and graph construction. The original Python implementation was replaced by the project's TypeScript runtime; snapshot contracts, safe acquisition, storage and orchestration are project-specific. Upstream-generated comparison outputs are retained only as bounded test fixtures. | [MIT, CodeBoarding](licenses/upstream/codeboarding.txt). Retained conservatively for documented source lineage, not only as a thank-you. |
| [Understand Anything](https://github.com/Egonex-AI/Understand-Anything/tree/fe8c5bc591716aafd79b4765549328f08ef5a52e) | Reference for batched semantic analysis, worker responsibilities, architecture views and learning tours. Product Skills/contracts/runtime are maintained in this repository. Historical UA comparison outputs remain in test fixtures; the upstream plugin is not bundled or required. | [MIT, Yuxiang Lin and Infinite Universe, Inc.](licenses/upstream/understand-anything.txt). |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Named research/evaluation subject and cited teaching examples in `server/skills/*/examples.md` and `server/src/evals/architecture-quality-cases.ts`; not a product runtime dependency. Examples identify their own commits and source paths. | [Upstream MIT notice](licenses/upstream/deepseek-harness.txt). Referenced third-party articles remain credited at the point of use. |

## Dependencies and visual materials

- [Direct dependencies](licenses/DIRECT_DEPENDENCIES.md): package purpose/scope,
  exact locked version and declared license.
- [Complete npm inventory](licenses/NPM_DEPENDENCIES.md) and
  [machine-readable inventory](licenses/npm-inventory.json): runtime, development,
  optional and transitive packages, with original collected LICENSE/NOTICE texts.
- [Visual assets](licenses/ASSETS.md) and [per-file evidence](licenses/assets.json):
  Devicon, IconPark, LobeHub Icons, SVGL, Simple Icons, Jason Handwriting, and
  Sketchy Icons' Lucide/Feather ancestry.
- [Distribution notes](licenses/DISTRIBUTION.md): declared-only package exceptions,
  build-tool licenses, container/runtime boundaries and redistribution requirements.

## Research acknowledgements (not bundled dependencies)

The following projects helped evaluate designs. Listing them does not claim
affiliation, endorsement, joint authorship, or a license to their code under our MIT.

| Reference | What was studied / current boundary |
| --- | --- |
| [Aider](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c) | Repository maps, bounded context, relevance, caching and finite retries. No Aider package/source is bundled. Apache-2.0 applies if its code is incorporated in future. |
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus/tree/dea396a13ca78e3301d6b95b1ab50374a6a34758) | Derived communities/processes, deterministic traversal and bounded query tools. Its PolyForm Noncommercial implementation and graph database stack are not incorporated. |
| [React Flow Smart Edge](https://github.com/tisoap/react-flow-smart-edge/tree/0b73a4056e0da894513a7bc29e89ac85f40f0f99) | Evaluated for edge routing, then removed. Current graph edges use React Flow's Bezier paths; no Smart Edge dependency or routing implementation remains. |
| [GraphRAG](https://github.com/microsoft/graphrag/tree/f40e9a26ce62ba0b3fef8837d24aafdcc6e6c704) and [Guardrails](https://github.com/guardrails-ai/guardrails/tree/06d0ff2c5f9bcb493d976b76f885e37e41ce845d) | Read-only investigation of compact identifiers, context representation and schema checking. Neither is a runtime dependency. |
| [React Bits](https://github.com/DavidHDev/react-bits) | Earlier visual-effect experiments. The imported animation components were removed; current text styling is a small project-maintained CSS treatment. React Bits' MIT + Commons Clause terms are not a plain MIT grant and do not apply to our entire project. Do not reintroduce its components as MIT-only code. |
| [Tavily Skills](https://github.com/tavily-ai/skills), [Slonik](https://github.com/gajus/slonik), [DDGS](https://github.com/deedy5/ddgs), [Promptfoo](https://www.promptfoo.dev/), LangGraph and Pydantic AI documentation | References for search, SQL batching, search-provider behavior, evaluation, dependency ordering and retries. These libraries/skills are not bundled by this project. |
| Provider documentation and SDK examples, including [Xiaomi MiMo](https://github.com/XiaomiMiMo/awesome-mimo-agent), [Z.ai](https://github.com/zai-org/z-ai-sdk-python) and [Qwen Code](https://github.com/QwenLM/qwen-code) | API compatibility and troubleshooting references; not additional copied runtimes. |

Research clones, analysis downloads, internal collaboration notes and development
history are excluded from this source snapshot. A repository analyzed by the
product is not automatically a dependency of the product.

## Maintenance

Run `node scripts/check-license-inventory.mjs` after changing a manifest, lockfile
or bundled visual asset. Update the inventories and retain the exact relevant
upstream notice whenever introducing or changing third-party material. The check
validates recorded coverage and file integrity; it is not a legal determination
or a scan of unrecorded source derivations.
