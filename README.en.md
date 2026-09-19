<div align="center">

<h1>what-the-repo</h1>

<p><strong>Find what is worth learning in a repository. Understand it through code.</strong></p>
<p>Understand and learn from public GitHub repositories.</p>

<p><a href="README.md">简体中文</a> · <strong>English</strong></p>

<p>
  <a href="https://what-the-repo.com"><img src="https://img.shields.io/badge/Try%20online-7C5CBF?style=flat-square" alt="Try what-the-repo online"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/MIT%20license-D4A72C?style=flat-square" alt="Read the MIT license"></a>
  <a href="https://github.com/Yecernia/what-the-repo/releases/latest"><img src="https://img.shields.io/github/v/release/Yecernia/what-the-repo?style=flat-square&amp;color=39815A" alt="Latest release"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/Contribute-536878?style=flat-square" alt="Contribute"></a>
</p>

<p><img src=".github/assets/product-hero.svg" width="600" alt="what-the-repo — Start with curiosity. A line drawing of a person exploring code on a park bench."></p>

<p><a href="https://what-the-repo.com"><strong>Open what-the-repo ↗</strong></a> · <a href="https://github.com/Yecernia/what-the-repo/issues">Feedback & ideas</a></p>

</div>

## Found an interesting project. Where do you begin?

You know a repository has something to teach you. The harder part is deciding which files to read, which design choices matter, and why they work.

**what-the-repo turns that curiosity into a focused learning process.** Start with a public GitHub repository, explore its structure, choose a design or implementation to study, and follow the code until you can explain it yourself.

## From curiosity to understanding

### Choose a goal. Follow a learning route.

Turn a topic you care about into manageable steps. Confirm the route, work through focused explanations, and check your understanding before moving on. Questions and code references stay alongside your progress.

![A real DSH learning route in what-the-repo, with guided explanations and learning progress.](.github/assets/dsh-learning.jpg)

*Real product capture: studying the Agent runtime in [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). This example uses Chinese learning content.*

### Follow explanations back to the code.

Open cited files to see the implementation behind an explanation. Use the architecture view to explore components and their connections when you need the wider context.

![Selecting DSH’s session task list highlights related components and fades the rest.](.github/assets/dsh-component.jpg)

## What you can do

| What you want to understand | What what-the-repo can help with |
| --- | --- |
| **What is worth learning here?** | Discover topics in architecture, implementation and engineering tradeoffs, with reasons grounded in the repository. |
| **Does this explanation match the code?** | Follow files, symbols and line references to inspect the source, distinguishing facts, inferences and open questions. |
| **How can I learn this part systematically?** | Confirm a learning goal to get a step-by-step route, focused explanations and understanding checks. You can also ask questions freely. |
| **How does this project fit together?** | Explore an architecture map, components and relationships to connect entry points, responsibilities and important flows. |
| **Can I pick up where I left off?** | Keep projects, conversations and learning progress, with a memory summary you can control. |

Try asking:

> “Which three design choices are most worth studying in this repository? Show me the code behind them.”
>
> “Start at the request entry point and walk me through the main call chain.”
>
> “I want to understand how task recovery works here. Help me plan a learning route.”

## Get started online

1. Open **[what-the-repo.com](https://what-the-repo.com)** and sign in with GitHub or use the guest entry.
2. Paste a **public GitHub repository URL** and wait for its analysis.
3. Explore the project view, ask about something that interests you, or begin guided learning.

The interface and learning content support Chinese and English. Initial analysis takes time; duration depends on the repository and model responses.

## About this repository

This is the **source code of the hosted what-the-repo Web product**: frontend, backend, repository analysis, agents, tests and portable runtime templates. You do not need to clone this repository or install Docker to try the product online.

To explore the implementation or contribute, see the [contribution guide](CONTRIBUTING.md). Code entry points and common commands are in [AGENTS.md](AGENTS.md). A separate login-free local edition or desktop client has not been released.

## Development and independent deployment

This is the same Web product, not a separate desktop or personal edition. Local development uses the entry in [AGENTS.md](AGENTS.md). For Linux containers, use Docker with Compose 2.24.4 or newer.

Copy `.env.example` to an ignored `.secrets/runtime.env` and replace the database passwords, session/encryption secrets, OAuth application and model configuration with your own. For containers set `WHAT_THE_REPO_REDIS_URL=redis://redis:6379` and the OAuth callback to `<WHAT_THE_REPO_WEB_URL>/api/auth/github/callback` (locally, `http://127.0.0.1:5307/api/auth/github/callback`, not the internal API port). For a public instance set `NODE_ENV=production`, `WHAT_THE_REPO_WEB_URL` to your HTTPS origin, and register that matching callback in your own OAuth application. Optional COS, MCP, admin and search features can remain unconfigured.

```sh
docker compose --env-file .secrets/runtime.env -f compose.runtime.yaml up --build -d --wait
```

The composition initializes the database and starts PostgreSQL, Redis, API, analysis worker, retention scheduler and Web. Access Web on `127.0.0.1:5307`; API and database remain internal. On a server, terminate HTTPS at your own reverse proxy; a [placeholder Nginx template](infra/docker/public-edge.nginx.conf.template) is provided. Named volumes persist data; arrange and test your own off-host backups. Instance-specific ports, resource limits and networking belong in an ignored `compose.instance.yaml` passed with an additional `-f`.

`--scale api=2 --scale analysis-worker=2` exercises the same service code with replicas; keep the scheduler singleton. Optional `--profile monitoring` requires your metrics token and Grafana credentials. `--profile evolution` requires its own model configuration and grants the trusted worker Docker access; it is not started by default. For file-based credentials and read-only service filesystems, add [compose.runtime-secrets.yaml](compose.runtime-secrets.yaml), populate its declared secret files under `WTR_SECRET_ROOT`, and ensure container users can read only their mounted files. This optional overlay does not generate credentials.

PR verification includes [runtime configuration checks](scripts/test-runtime-config.mjs), [replica/failover smoke tests](scripts/test-runtime-compose.ps1) and [isolated PostgreSQL tests](scripts/test-postgres.mjs). These do not require the maintainer’s accounts or deployment files.

See [runtime capacity](docs/runtime-capacity.md) for concurrency settings, personal limits, analysis stage resources and migration from old configuration. Example values are not load-tested capacity claims.

## Feedback and contributions

Found an incorrect explanation, missing evidence or a confusing interaction? [Open an issue](https://github.com/Yecernia/what-the-repo/issues) with the public repository URL, steps to reproduce and expected behavior. Please leave out credentials and private data.

Code and documentation contributions are welcome through pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

Please follow our [code of conduct](CODE_OF_CONDUCT.md) in community spaces. To report a vulnerability, read the [security policy](SECURITY.md).

## License and acknowledgements

Original project code is licensed under [MIT](LICENSE). Third-party code, icons and fonts retain their respective terms.

The project uses the **Pi SDK** and has drawn on **CodeBoarding, Understand Anything** and other projects during research and implementation. See [third-party notices](THIRD_PARTY_NOTICES.md) for the ideas adopted and copyright notices.

---

<p align="center">MIT License © 2026 Yecernia</p>
