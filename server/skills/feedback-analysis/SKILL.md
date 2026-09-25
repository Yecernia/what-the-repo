---
name: feedback-analysis
description: Decide whether a button vote or natural-language reaction evaluates a given answer, extract reviewable quality signals and separate Skill, evidence, program and provider causes; never triggers a change by itself.
---

# Feedback Analysis

First confirm what the feedback points at, then extract observable problems, and only then form Skill hypotheses. The output is a signal to aggregate later; it never edits a Skill, creates a candidate or publishes anything.

Operators read `strengths`, `issues` and `skill_hypotheses` in the admin console, so write them in Simplified Chinese, describing patterns rather than quoting the user at length.

## Does the feedback target the answer?

A button vote proves an overall judgment, not its reason. Natural language counts as feedback only when it semantically evaluates `target_answer`. Follow-up questions, continuing a task, correcting a repository fact or changing topic are not automatically feedback; an evaluation and a new request can appear together. `feedback_hint` is only the tutor's lead: confirm it independently against the target answer and the neighbouring conversation, and allow for irony, understatement and mixed feelings.

When it is not feedback, output neutral sentiment, empty strengths, issues and hypotheses, and conservative confidence. Do not infer an evaluation from topic words.

## What went wrong in the answer?

Check the target answer's observable behaviour against the user's original question: did it answer the object that was asked about, are repository facts backed by directly relevant evidence, are fact, inference and unknown kept apart, does the explanation suit the user, did it overstep on route confirmation, did it miss a step the request needed, and did it expose internal identifiers such as tool names, action names or IDs to the user? `strengths` and `issues` describe these behaviours, not root-cause conclusions.

Keep mixed feedback as `mixed` and record strengths and problems separately instead of forcing a thumbs up or down. Normalise the same problem into a reproducible pattern; do not copy whole user messages or store sensitive content.

A button without a written reason supports only an overall positive or negative signal; do not invent specific reasons such as "accurate citations" or "did not answer the question". The user's emotion is not their personality, a stable preference or a product root cause.

## Separate the root cause

Rule out alternatives with `recent_traces`, in this order:

1. When the snapshot or tool results lack the needed fact, the evidence input was insufficient; rewriting a Skill cannot produce facts that do not exist.
2. When `stop_reason`, the model output or neighbouring runs show timeouts, network failures, provider errors, truncation or obvious random variation, record the observable problem but do not blame a Skill. One normal completion does not rule out provider variation either, so single-sample attributions stay conservative.
3. Schema validation, permissions, persistence, tool execution or front-end interaction failures are program or tool problems; they need code fixes, not Skill workarounds.
4. Only when the run was normal, the needed facts and tools were available, and the failure lies in how a Skill that actually ran queried, selected, ranked, explained or stopped, form a Skill hypothesis.

Add to `skill_hypotheses` only when all hold: the problem is within an allowed Skill's responsibility; the trace shows that Skill took part in the relevant behaviour; and its method rules could change the observed problem. The primary tutor Skill can affect final evidence gathering and wording; a specialised Skill is attributable only when its worker actually ran. If several stages could cause the same problem, keep the fewest, most direct candidates rather than listing the whole chain.

When you cannot separate answering method, repository peculiarities and provider variation, leave hypotheses empty and describe only the observable issue. Never attribute to feedback analysis itself or to the evolution method Skill.

`confidence` reflects three things at once: whether the feedback really targets the answer, whether the problem is concrete and reproducible, and whether traces support the cause. Dissatisfaction can be high confidence while the Skill attribution stays low; do not conflate the two. One piece of feedback is a signal to verify; only repeated aggregation and fixed evals justify an improvement task.
