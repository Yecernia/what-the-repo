<div align="center">

<h1>what-the-repo</h1>

<p><a href="README.md">简体中文</a> · <strong>English</strong></p>

<p><picture><source media="(prefers-color-scheme: dark)" srcset=".github/assets/readme-hero.en.dark.svg"><img src=".github/assets/readme-hero.en.svg" width="720" alt="what-the-repo — Start with curiosity. Understand it through the code. Illustration: under a big tree someone reads code on a laptop on a park bench while a friend gives a thumbs-up from behind; three paper cards float around them: an architecture map, a value point and a learning route."></picture></p>

<p>
  <a href="https://what-the-repo.com"><img src="https://img.shields.io/badge/Try%20online-39815A?style=flat-square" alt="Try what-the-repo online"></a>
  <a href="https://github.com/Yecernia/what-the-repo/releases/latest"><img src="https://img.shields.io/github/v/release/Yecernia/what-the-repo?style=flat-square&amp;color=39815A" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-39815A?style=flat-square" alt="MIT license"></a>
</p>

</div>

## Found an interesting project. Where do you begin?

You know a repository has something to teach you. The hard part is deciding which files to read, which design choices matter, and why they work.

what-the-repo turns that curiosity into focused learning: give it a public GitHub repository, see how it is built, find the designs worth studying, and follow the code until you can explain them yourself.

## What it looks like

These are real pages from studying [microsoft/vscode](https://github.com/microsoft/vscode), with Chinese learning content.

**Find what is worth learning.** Topics in architecture, implementation and engineering tradeoffs, each with the problem it solves and how it is built.

![VS Code’s value points, such as the service dependency graph with delayed instantiation and proposed API gating. The first is selected, showing the problem it solves, the core idea and how it is built.](.github/assets/vscode-values.jpg)

**Set a goal and learn step by step.** A topic becomes a route of small steps, each explained with the code and followed by a few questions to check your understanding. Progress, conversations and a memory summary are kept, so you can pick up where you left off.

![A six-step learning route through VS Code’s extension host: the end of the first explanation and its understanding check on the left, the route with the current step’s goal and completion check on the right.](.github/assets/vscode-learning.jpg)

**Follow explanations back to the code.** Every conclusion links to the files and lines behind it, and facts are kept apart from inferences. When you need the wider picture, the architecture view connects components and their responsibilities.

![Selecting the extension API type declarations (vscode-dts) component in VS Code’s architecture view shows its related component groups and what it does.](.github/assets/vscode-component.jpg)

## Try asking

> “Which three design choices are most worth studying in this repository? Show me the code behind them.”
>
> “Start at the request entry point and walk me through the main call chain.”
>
> “I want to understand how task recovery works here. Help me plan a learning route.”

## Get started

1. Open **[what-the-repo.com](https://what-the-repo.com)** and sign in with GitHub or continue as a guest.
2. Paste the URL of a public GitHub repository and wait for its analysis.
3. Explore the project view, ask about whatever interests you, or begin guided learning.

The interface and learning content support Chinese and English. The first analysis takes a while, depending on the repository's size and the model's responses.

## Contributing and self-hosting

This repository is the complete source of the hosted product: frontend, backend, repository analysis and agents. To read the code or contribute, see the [contribution guide](CONTRIBUTING.md); to run it on your own server, see [deployment](docs/deployment.md).

Found an incorrect explanation, missing evidence or something awkward to use? [Open an issue](https://github.com/Yecernia/what-the-repo/issues) with the public repository URL and steps to reproduce. Please leave out credentials and private data.

Please follow the [code of conduct](CODE_OF_CONDUCT.md) in community spaces, and see the [security policy](SECURITY.md) to report a vulnerability.

## License and acknowledgements

Original project code is licensed under MIT; third-party code, icons and fonts keep their own terms. The project uses the **Pi SDK** and drew on **CodeBoarding**, **Understand Anything** and other projects during research and implementation. See the [third-party notices](THIRD_PARTY_NOTICES.md).
