---
name: snapshot-language-overlay
description: Translate existing snapshot text into the requested language while preserving meaning, fixed identities and graph structure.
---

# Snapshot Language Overlay

Translate the supplied batch of an already analyzed repository snapshot. This is a text task: do not investigate source, discover new value points, change assignments or add/remove objects.

## Preserve the source contract

- Keep each `id`, `stable_id` or `kind` exactly as supplied. Every fixed object in the current batch appears once, and output `mode` matches input `mode`.
- Preserve component/layer ownership, value-point evidence bindings and relation direction. These facts are not translation choices.
- Preserve paths, symbols, class/function/package/protocol names, commands and code. Translate the surrounding explanation.
- Keep the literal `{count}` placeholder wherever present; never substitute a number. Keep empty source text empty.

## Translate meaning and scope

Use `target_language` for user-visible text. Understand the complete responsibility, rationale or tradeoff before rewriting it naturally. Retain member-specific differences, conditions and uncertainty; the translated title must not make a stronger claim than the body. Do not invent an engineering reason missing from the source.

If supplied material identifies an official name in the target language, retain it verbatim, including mixed-language wording, instead of polishing or retranslating it. Do not invent an official attribution: this worker has no web/source tools, so an official target-language name must actually be supplied. Otherwise translate the original concept by meaning, choosing familiar wording rather than word-for-word metaphors or lists of children. Preserve identifiers while writing the surrounding explanation in the target language. Length ceilings prevent abnormal output, not require equal character counts between languages.

Examples of expression, not facts to add:

- Source title "一切皆插件" becomes "Everything is a plugin". Preserve that short concept; do not expand it into "A comprehensive extensible capability ecosystem". The verified DSH wording is an example, not a reason to relabel unrelated source titles.
- "一个请求取消时，其他仍在等待的请求可以继续等待同一次上传。" becomes "When one request is cancelled, the other waiting requests can continue waiting for the same upload." Do not strengthen it to "Cancellation can never affect another request."
- "{count} 条调用关系" becomes "{count} call relations" with the placeholder unchanged.

## Submit

Use `submit_result` for the current batch. Correct missing/duplicate objects, IDs or language errors without deleting objects to evade validation. Stop when every nonempty text field uses the target language, meaning stays within the source, and identifiers/placeholders remain intact. Where wording is uncertain, choose a narrower faithful expression instead of guessing new facts.
