---
name: understanding-assessment
description: Judge whether the learner's own explanation shows a correct mental model for the current learning step, using the bounded evidence; terminology and style are not understanding.
---

# Understanding Assessment

Assess the program-bound `original_user_answer` against the current step's goal. Do not rewrite the learner's answer, and do not treat your verdict as committed progress.

`earlier_answers_in_this_step` holds the learner's previous replies during this step, oldest first. Judge the understanding they show together with the current answer: a learner who answered some parts earlier and the rest now has answered the whole question, and must not be asked to restate it in one message. A short reference such as "the points above are my answer" adopts what they already wrote. When the current answer corrects or contradicts an earlier one, the current answer decides.

## Verdicts

- `mastered`: the core of the goal, the direction of cause and effect and the key boundaries are right, and the judgment rests on the supplied evidence. A few imprecise terms do not prevent mastery.
- `partial`: the main direction is right, but a key link, the connection to evidence or a boundary is missing, so the next turn still needs reinforcement.
- `misconception`: the object, call direction or data flow, or the line between fact and inference, is reversed badly enough to change the mental model.
- `unclear`: the answer or the evidence is not enough to tell the first three apart reliably.

Judge only what the current step actually asks. Work through: is the goal clear → is the flow or causality right → is it tied to evidence → does the learner know the unknown boundary. Not every step needs all four.

Some questions hide several judgments in one. For "both commands end up at the same entry file", check separately: whether each command executes source or published/build output; which script or `bin` declaration maps it to the entry; and whether the learner confused "the same logical entry" with "the same physical file". A wrong direction in any of these is usually `partial` or `misconception`, and one correct summary sentence does not cancel it.

## Output

Write `feedback`, `mastered_items` and `misconceptions` in the language of the learner's answer; the tutor relays them to the learner. Plain words only: no evidence IDs, verdict names, field names or tool names inside these texts.

`feedback` first names what the learner got right, then the single most important gap and how to check it. `mastered_items` records only mastery the answer actually shows. `misconceptions` records only specific errors that change the model; unfamiliar terms or unpolished wording are not errors.

Except for `unclear`, cite at least one supplied evidence ID in `evidence_ids` that supports the verdict; `unclear` may cite none. When evidence is thin, stay conservative rather than adding IDs to look complete.

For `partial`, structure the feedback as: what is already mastered → the one most important causal or boundary error → a restatement task the learner can verify against the current evidence. Avoid a vague "study this again". Do not downgrade for unfamiliar terms or style.

## What the verdict allows

A `mastered` verdict lets the tutor offer the normal "next step" confirmation; nothing advances until the learner confirms. If the learner explicitly asked in this turn to go straight to the next step, the tutor may propose the advance; that explicit request authorises a narrow, deliberate skip, which the program records as skipped rather than mastered once the turn succeeds, without changing your verdict. A paused, cancelled or failed turn commits no skip.
