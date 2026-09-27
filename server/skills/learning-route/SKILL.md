---
name: learning-route
description: Turn a learning target the learner has confirmed into a reading route backed by real components and evidence; not for ordinary questions or for advancing a course automatically.
---

# Learning Route

You only handle a target the learner has already approved through a confirmation card. A route is the main thread that lets a learner build a mental model they can explain back; it is not a table of contents, and building it does not change learning state.

## Learner-visible language

- `display_language` in the input is the learner's language for this route. Write `title`, `objective` and `completion_check` in it.
- Keep file paths, symbols, package names, commands and code exactly as they are, embedded in sentences of the target language. Do not translate a technical identifier into a name that does not exist.
- These fields are read by a learner, not by the program: describe goals and checks in ordinary words, and never put component IDs, evidence IDs, tool names or schema field names into them.
- A language mismatch is never a reason to drop steps or return an empty route. When submission reports a language error, keep the component and evidence bindings, rewrite the natural-language fields and submit again.
- Reduce steps or return an empty route only when evidence is insufficient, and never pad with generic textbook material.

## Gather evidence

1. Interpret the scope of `confirmed_target` first. A repository target needs the entry points that reveal the main flow; a value point needs its implementation; a component or layer is explored inside its own boundary.
2. Build a candidate map by paging through `list_repository_components` until there is no `next_offset`. Page members and relations with `get_repository_component`, and follow collaborations from input to output with `query_repository_relations`.
3. Confirm evidence IDs with `get_repository_evidence`. When you know a file but not where the implementation is, locate it with `get_repository_file_outline`, then read the target and the context it needs with `read_repository_source`. On first access to a member file, pass both `component_id` and `path`; you do not need to page members first. A source `next_offset` only means more text exists: continue when the open question crosses the page, never infer cause from unread lines, and do not read whole files mechanically.
4. The target's scope must not prevent understanding a necessary neighbour. You may read neighbour summaries and relations, but every step's component ID must come from the current snapshot and serve the confirmed target.
5. Preserve the granularity the learner asked for. If they asked to learn the whole project, `confirmed_target` may be a reasonable component starting point, but do not silently narrow a repository-level intent to "just this component". State the starting point, the coverage and the plan to return to the main runtime path in the route metadata or the first step. Narrow the scope only when the learner explicitly chose one component or value point.

## Plan

- Decide the target question and its prerequisites first, then form a traceable main thread through entry points, collaboration, state and side effects. Do not follow architecture layers by rote.
- Each step answers one question and binds the smallest set of component and evidence IDs. `objective` states the connection the step builds; `learning_targets` lists one to six distinct, independently checkable subgoals that together cover the step; the tutor will ask and assess only selected subgoals at a time. `completion_check` asks the learner to explain, in their own words, the goal, flow, evidence or boundary.
- Adapt the starting point and step size to the learner profile; skip repeated, irrelevant or premature detail. Dependencies decide the number of steps; there is no fixed count.
- Every step must be backed by components and evidence in the current snapshot. Drop any step you cannot support.
- A repository-level route first establishes one traceable backbone: project identity and entry → core orchestration or runtime → key state and side effects → testing or deployment boundary. Workspace, build, lint or release configuration belongs only where it explains a necessary part of that backbone; easy evidence is not a reason to fill the route with it.
- Check coverage before submitting: does each step answer a different question, does each depend on the one before, is there at least one core-behaviour step rather than only configuration, and can the learner use each check to restate facts, order and known unknowns? If the route drifts into a configuration list, query the core components and relations again and reorder instead of submitting the first draft.
- When a repository-level target can only start from one component, the first step may cover entry or configuration, but later steps must follow what that entry calls. Never present a component-level start as full-project coverage.

## Gaps and stopping

Complete the narrower route the evidence supports. If evidence cannot support any reliable step, return empty `steps` and keep the gap visible. Web pages, READMEs, component names or model knowledge alone are not route evidence. Stop when the target's main thread is covered and further queries would only repeat it.

If a batch of evidence or a source read fails, keep the confirmed steps and mark the gap. Do not fill the step count with neighbouring configuration files, and do not report a provider failure as "the repository has no such flow".

Submission validates every component and evidence ID. Correct all invalid bindings and resubmit the entire ordered route; invalid middle steps are never silently removed.
