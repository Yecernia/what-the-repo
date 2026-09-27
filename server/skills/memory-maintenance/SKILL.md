---
name: memory-maintenance
description: Keep the stable preferences, background and learning profile from the learner's own recent words that stay useful across projects, handling updates and conflicts; never store repository facts, temporary tasks or sensitive content.
---

# Memory Maintenance

Only user messages are a source of personal information. Assistant messages help you resolve what the user refers to, but they are never evidence for a memory. The goal is to save the next project one genuinely useful question, not to keep a conversation summary.

## Decide in this order

1. Identify which stable concept a candidate is about and align it with a key in `existing_memories` or an existing profile claim. Reuse the stable key for the same concept; different wording is not a new memory.
2. Classify it. Background, preferences or long-term goals the user states explicitly about themselves, usable across projects, go into `memories`. Local learning judgments drawn from how the user actually answered go into `profile_claims`. One right or wrong answer supports only a narrow, low-confidence inference; it never diagnoses personality or fixed ability.
3. Decide whether it is new, an explicit update, a retraction or a passing remark. Output new items, explicit replacements, and explicit retractions. Bind each candidate to a real user message ID and quote short evidence that appears verbatim in it.
4. Finally check future value and sensitivity. Content that would not save a future conversation a useful question is not stored.

One clear long-term statement is enough; repeated temporary behaviour does not become long-term by itself. Exclude project goals, current to-dos, one-off commands, facts about the current repository, short-lived emotions, assistant suggestions, code, account identifiers, secrets and other sensitive information.

Write memory values in the language the user used for that statement, keeping their meaning rather than paraphrasing it into something they did not say.

## Updates, retractions and conflicts

A newer explicit self-statement outranks older memories and inferences. When the user gives a replacement value, output it under the same key so the program updates the record; do not keep contradictory versions. Explicit facts outrank behaviour-based inferences, and a narrow statement must not be widened into a general ability.

For an explicit retraction without a replacement, emit a `retractions` entry with the existing memory key or claim ID, its kind (`memory` or `claim`), the source message ID and verbatim evidence. Retract every conflicting representation of that concept. A replacement claim may name the old claim IDs in `supersedes`. Do not turn a negation into a positive memory or re-emit the old value. Also leave it alone when you cannot tell whether a change is permanent, a project-specific exception or a temporary condition; a conditional sentence must not overwrite a stable preference.

Never merge two conflicting statements into a third conclusion the user never stated. An existing record may itself be wrong; without new words from the user, do not reinforce it just because it exists.

## Confidence and stopping

Clear, unconditional self-statements can be high confidence. Conditional statements, fresh changes or statements that may apply only to the current project are lower. Behaviour-based inferences are lower still and describe only the observed scope. Return empty arrays when nothing stable would improve future conversations. Do not save weak, duplicate or sensitive candidates to fill the output.
