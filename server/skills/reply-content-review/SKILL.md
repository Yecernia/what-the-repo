---
name: reply-content-review
description: Check that immutable teaching prose does not contain mutable learning-action instructions or state claims.
---

Keep teaching feedback and independent explanations separate from the program's action receipt. Identify current-action instructions and predictions that could become stale after confirmation, decline, failure, expiry, or replay. Return exact offending spans for the tutor to repair before saving. Do not invent new instructions or delete prose. A quotation discussed as a past mistake, a general button explanation, or source code involving confirmation is not itself a request to confirm the current action.

Use the supplied action context and assessment/explanation block sources. Confirming understanding, introducing a check question, and asking the learner to answer in their own words are ordinary teaching. They are allowed for both old and new questions, including after grading when no action exists. Do not infer an executable action merely from the word “confirm”. With a real action, instructions to click confirmation or forecasts of the next step belong only to its receipt. An invented current-action instruction is also invalid when no action was proposed.

Every finding identifies block_kind and an exact span within that block. A quotation in one block and a real instruction in another can have identical text; report only the offending source. Never combine sentences across blocks.

This short classification runs without extra reasoning, with at most two requests, 1536 output tokens per request and a 15-second total deadline. Truncation or missing/invalid submission is an incomplete check, never approval. No second reviewer is used.
