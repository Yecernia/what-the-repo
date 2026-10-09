# README images

## Promotional illustration

`readme-hero.zh.svg` and `readme-hero.en.svg` show the product's bench scene by day: the learner reads code on a laptop under the tree while a friend gives a thumbs-up from behind the bench, and three paper cards (an architecture map, a value point and a learning route, worded after VS Code) float around them. `readme-hero.zh.dark.svg` and `readme-hero.en.dark.svg` are the same scene at night in the dark theme; the READMEs show them when the reader's system prefers a dark colour scheme. The scene, friend, cards, icons and wordmark are rendered from the product's own components ([FieldIllustration.tsx](../../web/src/FieldIllustration.tsx), [FieldFriend.tsx](../../web/src/FieldFriend.tsx), [BrandWordmark.tsx](../../web/src/BrandWordmark.tsx)) with its light and dark colour tokens, then saved as self-contained vector paths, including the text, which is outlined from JasonHandwriting9p.

The text outlines come from JasonHandwriting9p under [SIL OFL 1.1](../../web/public/fonts/OFL-JasonHandwriting.txt). The illustration and the pen-stroke wordmark use the project's MIT license.

## Product screenshots

Product UI examples studying [microsoft/vscode](https://github.com/microsoft/vscode) at commit `e8f54c79d5c4`, captured at a 1280×800 window and exported at 1600×1000. Both README languages use these Chinese examples.

- `vscode-values.jpg`: the value points view, with the first value point (service dependency graph and delayed instantiation) selected beside the start of the first lesson.
- `vscode-learning.jpg`: a six-step learning route on the extension host beside the end of the first step's explanation and its understanding check.
- `vscode-component.jpg`: the extension API type declarations (vscode-dts) component selected in the extension API and type contracts layer of the architecture view, with its related component groups and description.

Font, icon and VS Code source notices are listed in [third-party notices](../../THIRD_PARTY_NOTICES.md).

## Navigation badges

The [Shields.io](https://shields.io/) labels link to the product, license, source and contribution guide.
