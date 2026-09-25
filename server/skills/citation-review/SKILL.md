---
name: citation-review
description: Check claim by claim whether the repository facts in a final answer are directly supported by the supplied evidence packets; used when evidence review is on, without new retrieval or rewriting.
---

# Citation Review

Review only the program-supplied `final_answer` and evidence packets. Do not look up more source, guess missing evidence or rewrite the answer.

## Judge each claim

1. Split the answer into the smallest repository claims that would change a reader's mental model. Judge separately that an object exists, what it is responsible for, call direction, data flow, state changes, scope, causality and design constraints. A sentence that says what exists, how it collaborates and why it was designed that way is several claims.
2. Classify each claim. A repository fact needs code or configuration evidence. A conclusion explicitly framed as an inference needs evidence for its premises but must not be treated as confirmed. Suggestions, encouragement, user preferences and stated unknowns need no code proof.
3. For each repository claim, check subject, behaviour, direction, conditions, scope words and version. If any key part is unproven, the claim fails even when the rest of the sentence is right.
4. For each supported claim choose the smallest sufficient evidence set. A call chain needs its key edges; a data flow needs input, transformation and output; configured behaviour usually needs both the declaration and the place that consumes it. Do not hide a missing link behind many weakly related packets.
5. Normalise paths and media before judging:
   - Remove `./`, repeated separators and non-repository prefixes left by build tools. A normalised path must exist among the current snapshot's source files.
   - Build output such as `lib/*.js`, dist or bundles is a post-build mapping or a build fact. Unless the evidence actually read that artefact, it is not direct evidence for `.ts` source lines.
   - Relative fragments without a repository root such as `src/bin.ts`, targets the snapshot never exposed such as `profile-boot.ts`, and paths only mentioned by a step or the user are `unverified_reference`; never put them in `accepted_evidence_ids`.
   - When one answer mentions both a source entry and a published-package entry, check the script or caller, the `bin` declaration, the build mapping and the execution conditions separately. "Both end at the same logical entry" does not prove "the same file executes".

## Levels of support

- **Direct**: the evidence alone establishes the whole claim, including object, direction, scope words and conditions.
- **Partial**: it only shows that a file or symbol exists, a local behaviour, or a correlation; it cannot establish the full flow, the global scope or the design reason.
- **Unsupported or conflicting**: the evidence is unrelated, points the other way, covers a narrower scope, or lacks a key link.

`unverified_reference` is not partial support: the path or lead itself has not been confirmed by this turn's evidence. Feedback may suggest retrieving it again, but it cannot be cited as fact.

When source code or a deterministic relation conflicts with a README, comment or component summary, the more direct code fact wins and the claim is listed as conflicting. Matching paths, similar names, adjacent definitions, README self-descriptions and component grouping do not prove runtime behaviour. Strong scope words such as "all", "only", "always", "never" or "the core reason" need matching coverage: one call edge does not prove a global call chain, and one implementation does not prove the maintainers' motive. A comment can show intent or a mapping lead, but not runtime behaviour unless the implementation agrees.

## Result

`accepted_evidence_ids` holds only the smallest set of IDs that directly support at least one important claim; leave out evidence that is related but insufficient, and list each ID once.

Set `supported=true` when every important repository claim is directly supported. If any claim that changes the answer's meaning is only partially supported, unknown or conflicting, set it to false and describe in `unsupported_claims` the specific claim and whether the object, direction, scope, link or design basis is missing; "insufficient evidence" alone is not enough. Write those descriptions in the language of `final_answer`. An answer without repository claims may return true with no IDs and a note that no review was needed. When unsure, do not pass; overall relevance must not hide a local gap.
