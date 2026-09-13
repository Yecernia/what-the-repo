# Third-party notices

[Back to product overview](README.en.md)

Original what-the-repo code is licensed under [MIT](LICENSE). Third-party code, fonts, icons and packages retain their respective licenses, linked below.

## Code and material sources

| Project | Use in what-the-repo | License and notices |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi/tree/v0.84.1) | The Agent/AI SDK runs the conversation agent and Evolution Coding Agent. The source-reading tool adapts Pi's reading and truncation implementation, adding path validation, UTF-8 whole-line pagination and continuation information. | [MIT, Mario Zechner](licenses/upstream/pi.txt). Pi package versions are recorded in the npm inventory. |
| [CodeBoarding](https://github.com/CodeBoarding/CodeBoarding/tree/164d75247ab933978790a9b4a42f4192ca54f484) | Parts of repository analysis draw on and adapt CodeBoarding's language adapters, LSP/Tree-sitter analysis and graph construction in TypeScript. Evaluation fixtures also retain upstream-generated comparison samples. | [MIT, CodeBoarding](licenses/upstream/codeboarding.txt). |
| [Understand Anything](https://github.com/Egonex-AI/Understand-Anything/tree/fe8c5bc591716aafd79b4765549328f08ef5a52e) | Batched semantic analysis, worker roles, architecture views and learning tours draw on UA's design, adapted to this project's hosted workflow. Evaluations retain some comparison samples. | [MIT, Yuxiang Lin and Infinite Universe, Inc.](licenses/upstream/understand-anything.txt). |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Used in teaching examples, analysis evaluations and README product screenshots. Source examples identify their commit and file locations. | [MIT](licenses/upstream/deepseek-harness.txt). |

## Dependencies and visual assets

- [Direct dependencies](licenses/DIRECT_DEPENDENCIES.md): modules, purposes, versions and licenses.
- [Full npm inventory](licenses/NPM_DEPENDENCIES.md) and [machine-readable records](licenses/npm-inventory.json): all dependencies and their LICENSE/NOTICE texts.
- [Visual assets](licenses/ASSETS.md) and [asset inventory](licenses/assets.json): icon, font and illustration sources, changes and file hashes.
- [Distribution notes](licenses/DISTRIBUTION.md): gaps in license records and requirements for packaged images or installers.

## Acknowledgements

Ideas from these projects are used in the current implementation. Thank you for sharing your designs and experience.

| Project | Ideas adopted |
| --- | --- |
| [Aider](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c) | Organizing repository context by relevance and budget, reusing analysis caches, and limiting retries by error type. |
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus/tree/dea396a13ca78e3301d6b95b1ab50374a6a34758) | Deriving groups and flows from a fact graph, using stable traversal order, and giving query tools output limits and pagination. |
| [React Bits](https://github.com/DavidHDev/react-bits) | The thinking-summary shimmer draws on Shiny Text, with adjusted colors and animation parameters. |
| [Tavily Skills](https://github.com/tavily-ai/skills) | Short queries, follow-up searches for specific questions, fetching content as needed, and checking source and project identity. |
| [Slonik](https://github.com/gajus/slonik) | Bulk-insert design, implemented with PostgreSQL JSON recordsets to write analysis data in batches. |
| [Promptfoo](https://www.promptfoo.dev/) | Fixed evaluation cases and categorized assertions for structure, content quality and duration. |

## Maintenance

When dependencies or assets change, update their inventory records and license texts, then run `node scripts/check-license-inventory.mjs`. See [license inventory maintenance](licenses/README.md) for the steps.
