import assert from "node:assert/strict";
import test from "node:test";
import { createProject, emptyProfile } from "../domain/conversation.js";
import { isExplicitAdvanceRequest, learningStatusText, parseUiSelections, primarySystemPrompt } from "./prompts.js";

test("explicit advance intent is recognized only from the current user message", () => {
  assert.equal(isExplicitAdvanceRequest("直接进入下一步"), true);
  assert.equal(isExplicitAdvanceRequest("我想跳过这一步的理解检查"), true);
  assert.equal(isExplicitAdvanceRequest("请解释一下当前步骤"), false);
  assert.equal(isExplicitAdvanceRequest("不能跳过检查"), false);
  // The one-tap skip option sends these exact sentences.
  assert.equal(isExplicitAdvanceRequest("跳过这一步的理解检查，直接进入下一步。"), true);
  assert.equal(isExplicitAdvanceRequest("Skip the understanding check for this step and go to the next step."), true);
  assert.equal(isExplicitAdvanceRequest("Can you explain the next step?"), false);
  assert.equal(isExplicitAdvanceRequest("Don't skip the check"), false);
});

test("primary dynamic prompt binds the user's explicit skip choice", () => {
  const project = createProject("guest:prompt", "https://github.com/example/prompt", "prompt", "free:test");
  const prompt = primarySystemPrompt({
    project,
    profile: emptyProfile(),
    selections: [],
    currentUserMessage: "直接进入下一步",
  });
  assert.match(prompt, /explicitly asks to go to the next step or skip the understanding check/);
  assert.match(prompt, /propose_learning_action/);
  assert.match(prompt, /records this explicit request as a skipped step/);
});

test("primary prompt fixes the user-visible file citation format", () => {
  const project = createProject("guest:prompt-files", "https://github.com/example/prompt-files", "prompt-files", "free:test");
  const prompt = primarySystemPrompt({
    project,
    profile: emptyProfile(),
    selections: [],
  });
  assert.match(prompt, /full repository-relative path/);
  assert.match(prompt, /`src\/path\/file\.ts:12-18`/);
  assert.match(prompt, /Listing file names after naming their directory is also fine/);
  assert.match(prompt, /Field\.eval/);
});

test("chat language has a UI fallback without locking replies to the project language", () => {
  const project = createProject("guest:language", "https://github.com/example/repo", "中文项目", null, "zh-CN");
  const prompt = primarySystemPrompt({project,profile:emptyProfile(),selections:[],currentUserMessage:"hello",displayLanguage:"en"});
  assert.match(prompt, /use the interface language: English/);
  assert.match(prompt, /a language the user explicitly asked for/);
  assert.match(prompt, /"hello" gets an English greeting/);
});

test("only graph objects attached to the message reach the prompt, several at a time", () => {
  const project = createProject("guest:attach", "https://github.com/example/attach", "attach", "free:test");
  const attached = parseUiSelections({ ui_contexts: [
    { snapshot_id: "s1", kind: "component", stable_id: "component:a", label: "入口" },
    { snapshot_id: "s1", kind: "relation", stable_id: "relation:a-b", label: "入口调用服务" },
    { snapshot_id: "s1", kind: "component", stable_id: "component:a", label: "重复" },
    { snapshot_id: "s1", kind: "file", stable_id: "x", label: "不支持的类型" },
    "not an object",
  ] });
  assert.deepEqual(attached.map((item) => item.stable_id), ["component:a", "relation:a-b"]);
  const prompt = primarySystemPrompt({ project, profile: emptyProfile(), selections: attached });
  assert.match(prompt, /The learner attached 2 graph object\(s\) to this message/);
  assert.match(prompt, /relation:a-b/);
  assert.match(primarySystemPrompt({ project, profile: emptyProfile(), selections: [] }), /attached no graph objects to this message/);
  assert.equal(parseUiSelections({ ui_context: { snapshot_id: "s1", kind: "value_point", stable_id: "v", label: "旧客户端" } }).length, 1);
  assert.equal(parseUiSelections({ ui_contexts: Array.from({ length: 12 }, (_, i) => ({ snapshot_id: "s1", kind: "component", stable_id: `c${i}`, label: "" })) }).length, 8);
});

test("the tutor is told not to show internal identifiers", () => {
  const project = createProject("guest:ids", "https://github.com/example/ids", "ids", "free:test");
  const prompt = primarySystemPrompt({ project, profile: emptyProfile(), selections: [] });
  assert.match(prompt, /Never write internal identifiers in the reply/);
  // Progress reaches the tutor in plain words, so it has something other than the phase value to say.
  assert.match(prompt, /in plain words .*No learning target has been chosen/);
  assert.match(prompt, /internal, for tool use only; never quote them/);
});

test("learning status is described without internal phase values", () => {
  const project = createProject("guest:status", "https://github.com/example/status", "status", "free:test");
  assert.equal(learningStatusText(project.study), "No learning target has been chosen and there is no route yet.");
  project.study.phase = "assessing";
  project.study.current_step = 1;
  project.study.total_steps = 4;
  assert.equal(learningStatusText(project.study),
    "A route is active; the learner is answering the check question for step 2 of 4.");
  for (const phase of ["orienting", "proposing", "explaining", "assessing", "remediating", "completed"] as const) {
    project.study.phase = phase;
    assert.doesNotMatch(learningStatusText(project.study), /orienting|proposing|explaining|assessing|remediating|mastered/);
  }
});
